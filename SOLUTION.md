# DevSecOps Lab — Job Board Platform: Solution

All command output in this document was captured from a live run on Docker Engine 29.4.3
(Docker Desktop, 12 CPU / 8.2 GB) with Trivy 0.72.0. Raw scan reports are committed under
[`evidence/`](evidence/).

---

## Pre-work: four defects that stopped the lab from running

The project as delivered does not build or run. These had to be fixed before any task could
be attempted, and each is a separate commit so the change is auditable.

### 1. Missing `package-lock.json` — the build fails outright

`applications-service/Dockerfile` and `frontend/Dockerfile` both invoke `npm ci`, but no
lockfile was committed anywhere in the repository:

```
target applications-service: failed to solve: process "/bin/sh -c npm ci --only=production"
did not complete successfully: exit code: 1
```

`npm ci` exists specifically to install from a committed lockfile and refuses to run without
one. The fix is to generate real lockfiles rather than to downgrade the command to
`npm install`, because:

- `npm ci` is what gives a reproducible dependency tree — swapping to `npm install` would let
  the tree drift between builds, which contradicts Task 1's goal of deterministic images;
- Task 4.2's `lint-test-node` stage runs `npm audit`, which needs a lockfile to resolve a
  dependency graph at all.

Lockfiles were generated inside `node:20-alpine` so the resolved tree matches the image that
actually builds the app, not the host's Node version.

### 2. `frontend/nginx.conf` starts with `eserver`

```
2026/08/05 04:43:23 [emerg] 1#1: unknown directive "eserver" in /etc/nginx/conf.d/default.conf:1
```

The first line reads `eserver {` instead of `server {`, so nginx aborted at startup and the
frontend container crash-looped (`Restarting (1)`). Confirmed as an upstream typo, not a local
artifact — the git blob `efb3202` and the raw GitHub file both contain the stray `e`.

### 3. `/api/jobs/` returned the SPA instead of JSON

The single most consequential defect: the job listing in the UI was broken, and the nginx
container reported permanently unhealthy.

`jobs-service/app/main.py` declares routes without a trailing slash (`@app.get("/jobs")`),
while `nginx/nginx.conf` rewrote `^/api/jobs/(.*)` to `/jobs/$1`. A request for `/api/jobs/`
therefore reached FastAPI as `/jobs/`, Starlette's `redirect_slashes` answered `307` to
`http://localhost/jobs`, and that path no longer matched `location /api/jobs` — it fell
through to `location /` and was proxied to the React frontend.

Measured before the fix:

```
GET /api/jobs/          -> 307, Location: http://localhost/jobs
  (following)           -> 200 text/html      <-- the SPA, not the API
GET /api/jobs           -> 200 application/json
GET /api/applications/  -> 200                <-- control: unaffected
GET /api/applications   -> 200
```

The applications-service is immune because Express treats `/applications` and
`/applications/` as the same route; FastAPI does not.

Fixed in `nginx/nginx.conf` by collapsing the bare collection path onto `/jobs` before the
sub-path rule is considered:

```nginx
rewrite ^/api/jobs/?$   /jobs    break;   # /api/jobs and /api/jobs/ -> /jobs
rewrite ^/api/jobs/(.*) /jobs/$1 break;   # /api/jobs/{id}           -> /jobs/{id}
```

After the fix, `GET /api/jobs/` returns `200 application/json`.

> Related documentation error: the README's `http://localhost/api/jobs/docs` cannot work — it
> rewrites to `/jobs/docs`, which is not a FastAPI route. The Swagger UI lives at `/docs` on
> the service itself, reachable with `docker compose exec jobs-service wget -qO- 127.0.0.1:8000/docs`
> or by publishing the port.

### 4. nginx healthchecks probed `localhost` on an IPv4-only listener

Both nginx-based images reported `unhealthy` forever despite serving traffic correctly:

```
Output: "wget: can't connect to remote host: Connection refused"
```

Proven from inside the container:

```
wget --spider http://127.0.0.1:80/api/jobs/   -> exit 0
wget --spider http://[::1]:80/api/jobs/       -> Connection refused
netstat -tlnp -> tcp 0.0.0.0:80 LISTEN 1/nginx
```

`listen 80;` binds IPv4 only, `localhost` resolves to `::1` first inside the container, and
busybox `wget` does not fall back to IPv4. The Python and Node services were unaffected —
Node binds dual-stack, and Python's `urllib` retries across address families. Fixed by
probing `127.0.0.1` in `nginx/Dockerfile` and `frontend/Dockerfile`.

With all four fixed, every container reports healthy:

```
NAME                   STATUS
applications-service   Up (healthy)
jobboard-db            Up (healthy)
jobboard-frontend      Up (healthy)
jobs-service           Up (healthy)
nginx-proxy            Up (healthy)
```

---

## Task 1 — Dockerfile Analysis & Hardening (20 pts)

### 1.1 Vulnerability scan

A note on method: the lab's `trivy image jobboard-jobs-service:latest` commands only work if
the images carry those names. Compose derives image names from the project directory, so the
images were originally built as `lab-job-board-jobs-service`. Fixed by pinning the project
name and image tags in `docker-compose.yml`:

```yaml
name: jobboard
...
  jobs-service:
    build: ...
    image: jobboard-jobs-service:latest
```

Scans were run as `trivy image --scanners vuln <image>`; full reports are in
[`evidence/trivy/`](evidence/trivy/).

**How many CRITICAL CVEs in total across all images?**

**5** before hardening — 4 in `jobboard-jobs-service` and 1 in `jobboard-applications-service`.
The two nginx-based images were already clean.

| Image | CRITICAL | HIGH | Total |
|---|---|---|---|
| `jobboard-jobs-service` | 4 | 22 | 186 |
| `jobboard-applications-service` | 1 | 17 | 28 |
| `jobboard-frontend` | 0 | 0 | 0 |
| `jobboard-nginx` | 0 | 0 | 0 |

**Which image has the most vulnerabilities?**

`jobboard-jobs-service`, by a wide margin — 186 findings versus 28 for the next worst. The
cause is the base image, not the application: it was the only service built on
`python:3.12-slim` (Debian 13.6), while the other three use Alpine. Debian's default package
set is much larger, so its vulnerability surface is correspondingly larger.

**One CRITICAL CVE explained — CVE-2026-42496**

- **(a) What it is.** A path-traversal flaw in `Archive::Tar` before 3.08. Its
  `_make_special_file()` passes the tar header's `linkname` straight to `symlink()` without
  checking for absolute paths or `..` segments, and the secure-extract guard that protects
  regular files does not cover symlink targets. Extracting a crafted archive therefore plants
  a symlink pointing anywhere on the filesystem, and the next open through that name reads or
  writes the attacker's chosen path. CVSS v3 9.1 (NVD).
- **(b) Affected package.** `perl-base` 5.40.1-6, pulled in by the `python:3.12-slim` Debian
  base image — not by anything in `requirements.txt`.
- **(c) Fix / mitigation.** Trivy reports `FixedVersion: <none>` and `Status: fix_deferred`:
  Debian has published no patched `perl-base`, so `apt-get upgrade` cannot clear it. That
  leaves three options: (i) change the base image, (ii) remove the vulnerable package, or
  (iii) accept and document the risk. Option (ii) is not viable — `perl-base` is an Essential
  package that `dpkg` depends on. **This project took option (i).**

  It is worth noting the *reachability* is low here: this service never invokes Perl and never
  extracts tar archives, so the flaw is not exercised by the application. But an unfixable
  CRITICAL in a base image is exactly the signal that the base image is the wrong choice, and
  the same base carried 185 other findings.

### 1.2 Hardening applied

**Base image changed (jobs-service): `python:3.12-slim` → `python:3.12-alpine`.**
This is what removed all four unfixable CRITICALs. `psycopg2-binary` ships manylinux wheels
only, so on musl it must be compiled — the toolchain (`gcc`, `musl-dev`, `postgresql-dev`,
`python3-dev`) is installed as a virtual package in the builder stage and deleted there, with
only `libpq` present at runtime. Verified end to end: full CRUD against PostgreSQL works
(`POST /jobs` → 201, `POST /applications/` → 201, `DELETE /jobs/{id}` → 204).

**npm and corepack removed from the runtime image (applications-service).**
This was the entire source of that image's CVEs. All 18 HIGH/CRITICAL findings were in
libraries bundled *inside npm* — `tar`, `sigstore`, `glob`, `minimatch`, `cross-spawn`,
`brace-expansion`, `ip-address` — under `/usr/local/lib/node_modules/npm`, reported by Trivy
against target `Node.js`. The service's own 85 production dependencies scanned completely
clean; `tar` was not even present in `/app/node_modules`. Since the container starts with
`node src/index.js` and never shells out to npm, deleting it is free.

**All `FROM` tags pinned to digests**, in all four Dockerfiles plus `postgres` in
`docker-compose.yml`. A moving tag would silently invalidate every scan result recorded here.

```dockerfile
FROM python:3.12-alpine@sha256:6d43704baacd1bfbe7c295d7f13079d5d8104ed33568873133f8fc69980419df
FROM node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293
FROM nginx:1.27-alpine@sha256:65645c7bb6a0661892a8b03b89d0743208a18dd2f3f17a54ef4b76fb8e2f2a10
image: postgres:16-alpine@sha256:57c72fd2a128e416c7fcc499958864df5301e940bca0a56f58fddf30ffc07777
```

**Non-root verified, and UIDs aligned with Kubernetes.** The original Dockerfiles used
`adduser --system`, which allocates from the 100–999 system range — but
`k8s/03-jobs-service.yaml` and `k8s/04-applications-service.yaml` both pin `runAsUser: 1000`,
so the image user and the manifest disagreed. Both now resolve to UID 1000:

```
jobboard-jobs-service          -> whoami=appuser  uid=1000(appuser) gid=1000(appgroup)
jobboard-applications-service  -> whoami=node     uid=1000(node)    gid=1000(node)
```

For the Node service no user is created at all: the official image already ships an
unprivileged `node` account at UID/GID 1000. Creating a second account at 1000 fails the
build (`addgroup: gid '1000' in use`), and creating one at a different UID would contradict
the manifest.

**Layer count reduced.** `apt`/`apk` update, upgrade, user creation and cache cleanup are
chained into a single `RUN`, so package lists never persist in an intermediate layer. The
separate `RUN chown -R appuser:appgroup /app` was replaced with `COPY --chown=`, which sets
ownership as the layer is written instead of duplicating the whole tree into an extra layer.

**`.dockerignore` audited** (Task asks to verify completeness). All three are correct and
none of them excluded `package-lock.json`, which matters now that the lockfiles exist.
`jobs-service/.dockerignore` correctly excludes `tests/` — the pytest suite added in Task 4.3
runs on the CI runner, not inside the image.

**`HEALTHCHECK` audited** — two were broken and are fixed (see pre-work defect 4), and
`--only=production` was replaced with `--omit=dev` (deprecated in npm 9+).

### Results

| Image | CRITICAL/HIGH/total before | after | Size before | after |
|---|---|---|---|---|
| `jobboard-jobs-service` | 4 / 22 / 186 | **0 / 3 / 13** | 274 MB | **172 MB** (−37%) |
| `jobboard-applications-service` | 1 / 17 / 28 | **0 / 0 / 1** | 223 MB | **210 MB** (−6%) |
| `jobboard-frontend` | 0 / 0 / 0 | 0 / 0 / 0 | 98 MB | 98 MB |
| `jobboard-nginx` | 0 / 0 / 0 | 0 / 0 / 0 | 97.7 MB | 97.7 MB |

**All 5 CRITICAL vulnerabilities eliminated; 214 total findings reduced to 14.** The stack
remains fully functional with all five containers healthy.

---

## Task 2 — Docker Compose Orchestration (25 pts)

### 2.1 Logging configuration (8 pts)

A `logging` block was added to **all five** services:

```yaml
logging:
  driver: json-file
  options:
    max-size: "10m"
    max-file: "3"
```

Verified as applied by the daemon, not merely present in the file:

```
$ docker inspect jobs-service --format '{{json .HostConfig.LogConfig}}'
{"Type":"json-file","Config":{"max-file":"3","max-size":"10m"}}

$ docker compose config | grep -c "max-size"
5
```

Without this, `json-file` logs grow unbounded until they fill the disk — a container stuck in
a crash loop writing stack traces can consume tens of GB overnight. The setting caps each
service at 10 MB × 3 files = 30 MB, after which the oldest file is discarded.

### 2.2 Environment variable isolation (9 pts)

The original file used `${POSTGRES_PASSWORD:-jobboard123}`. That form supplies a default when
the variable is unset, which means **deleting `.env` would not break the stack** — it would
quietly start PostgreSQL with a weak, hard-coded password that is committed in the repository.
That is precisely the failure mode this task asks you to demonstrate, so the syntax was
changed to the required form `${VAR:?message}`:

```yaml
POSTGRES_DB:       ${POSTGRES_DB:?POSTGRES_DB is required - copy .env.example to .env}
POSTGRES_USER:     ${POSTGRES_USER:?POSTGRES_USER is required - copy .env.example to .env}
POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required - copy .env.example to .env}
```

**Step 3 — confirm that removing `.env` breaks the stack** (`evidence/02-env-failfast.txt`):

```
$ mv .env .env.backup && docker compose up -d
error while interpolating services.postgres.environment.POSTGRES_DB:
  required variable POSTGRES_DB is missing a value:
  POSTGRES_DB is required - copy .env.example to .env
exit code: 1
```

Nothing starts at all. After restoring `.env`, `docker compose config --quiet` validates again.

**Step 2 — strong password.** 24 characters, mixed case, digits and symbols. Character
selection was constrained deliberately, and this is a real trap in this stack:

- `$` is excluded because Compose interpolates `.env` values, so a password containing
  `$vLpZr` would be read as a variable reference rather than as literal text;
- `@ : / #` are excluded because the password is embedded in
  `postgresql://user:password@postgres:5432/db`, where those characters are URI delimiters —
  `#` would begin a fragment and `@` would break the userinfo/host split.

Only `! - _ . ~` are used, all legal unencoded in a URI userinfo field. Verified end to end:

```
$ docker compose config | grep DATABASE_URL
DATABASE_URL: postgresql://postgres:Kp9-Zr4Tn_Wd7.Lqx~Mv2!Bs@postgres:5432/jobboard
```

**Step 4 — `.env` is not committed:**

```
$ git check-ignore -v .env
.gitignore:2:.env	.env
```

**Why committing `.env` is a security risk.** Git history is permanent and distributed.
Deleting the file in a later commit does not remove it — the blob stays reachable from every
earlier commit, in every clone, fork and CI cache. A leaked production password must therefore
be treated as compromised and rotated; removing it from `HEAD` accomplishes nothing. Public
repositories are continuously scraped by automated scanners, and pushed credentials are
routinely exploited within minutes. Secrets in a repository also defeat access control:
everyone with read access to the code obtains production credentials, whether or not they
should have them.

Tooling that prevents it:

| Tool | Where it runs | What it does |
|---|---|---|
| `git-secrets` | pre-commit hook | Blocks commits matching credential patterns before they enter history |
| `truffleHog` | CI or ad-hoc | Scans full history, not just `HEAD`, using entropy analysis and live-credential verification |
| `gitleaks` | pre-commit + CI | Rule-based scanning, commonly used as a CI gate |
| GitHub secret scanning + push protection | server side | Detects known provider token formats and can reject the push outright |

The durable fix is to keep secrets out of the repository entirely — a secrets manager (Vault,
AWS Secrets Manager) or Docker/Kubernetes secrets, as implemented in Task 6.1.

### 2.3 Service restart policy and dependency ordering (8 pts)

Observed startup sequence (`evidence/03-startup-order.txt`), matching the expected order:

```
Container jobboard-db           Starting -> Started
Container jobboard-db           Waiting  -> Healthy      <-- gate
Container applications-service  Starting -> Started
Container jobs-service          Starting -> Started
Container applications-service  Waiting  -> Healthy      <-- gate
Container jobs-service          Waiting  -> Healthy      <-- gate
Container jobboard-frontend     Starting -> Started
Container nginx-proxy           Starting -> Started
```

**Dependency graph**

```
                        +--------------+
                        |   postgres   |   (no dependencies)
                        |  jobboard-db |
                        +------+-------+
                               | condition: service_healthy
                 +-------------+-------------+
                 v                           v
        +-----------------+        +-----------------------+
        |  jobs-service   |        | applications-service  |
        |  FastAPI :8000  |        |    Express :3001      |
        +--------+--------+        +-----------+-----------+
                 | condition: service_healthy  |
                 +-------------+---------------+
                               v
                       +---------------+
                       |   frontend    |
                       |  React :80    |
                       +-------+-------+
                               | plain depends_on == service_started
                               v
                       +---------------+
                       |     nginx     |   :80 published to the host
                       +---------------+
```

**`condition: service_healthy` vs `condition: service_started`**

`service_started` waits only until the container is *running* — the process has been spawned.
For a database that is nearly useless: PostgreSQL is running long before it can accept
connections, so a dependent service starting at that instant gets `connection refused` and
exits. `service_healthy` instead waits for the container's `healthcheck` to pass — here
`pg_isready -U postgres -d jobboard`, which confirms the server is genuinely accepting
queries. That is why both API services gate on `service_healthy`, and it is what prevents the
"`jobs-service` exits immediately" symptom listed in the lab's troubleshooting table.

Note that `nginx` uses the plain list form of `depends_on`, which is equivalent to
`service_started` and does *not* wait for the frontend to be healthy. That is acceptable here
because nginx re-resolves and retries upstreams per request, so the cost of being early is a
transient `502` rather than a crash.

**What happens if postgres crashes after the other services are running?**

Measured with `docker compose stop postgres` (`evidence/04-postgres-stop.txt`):

```
NAME                   STATUS
applications-service   Up (healthy)          <-- still reported healthy
jobboard-db            Exited (0)
jobboard-frontend      Up (healthy)
jobs-service           Up (healthy)          <-- still reported healthy
nginx-proxy            Up (healthy)

GET /api/jobs          -> 500  Internal Server Error
GET /api/applications/ -> 500
GET /                  -> 200  (static assets unaffected)
```

Three observations, the second of which is the important one:

1. **`depends_on` governs startup order only, never runtime.** Once started, the dependent
   containers are entirely unaffected by the database disappearing — Compose neither stops
   nor restarts them.

2. **The healthchecks are misleading.** Both API services kept reporting `healthy` while
   failing 100% of real requests, because `/health` returns a hard-coded
   `{"status": "healthy"}` without ever touching the database. In production this is
   actively dangerous: an orchestrator would keep routing traffic to a service that cannot
   serve any of it, and would never restart it or pull it from the load-balancer pool. The
   correct split is to keep the *liveness* probe shallow (is the process wedged?) but have
   the *readiness* probe execute something like `SELECT 1`, so that dependency failure
   actually removes the pod from rotation. The same flaw is inherited by the Kubernetes
   manifests, where `readinessProbe` and `livenessProbe` both point at this same `/health`.

3. **Recovery is automatic.** After `docker compose start postgres`, `GET /api/jobs` returned
   `200` again with no restart of the API services, because SQLAlchemy is configured with
   `pool_pre_ping=True` (`jobs-service/app/database.py:10`) and node-postgres' `Pool`
   reconnects on demand.

`restart: unless-stopped` is set on every service, so containers return automatically after a
daemon restart or host reboot, but *not* after a deliberate `docker compose stop` — which is
the intended distinction.

---

## Task 3 — Data Persistence & Backup (15 pts)

### 3.1 Verify persistence across restarts (5 pts)

Captured in `evidence/05-persistence.txt`:

```
$ curl -X POST http://localhost/api/jobs -d '{"title":"Persistence Test Job",...}'
{ "id": "de1138c5-58bd-4eba-856e-470f8b2a9bc7", "title": "Persistence Test Job", ... }

total jobs before restart: 6

$ docker compose stop && docker compose start

total jobs after restart: 6
Persistence Test Job present: True
  id: de1138c5-58bd-4eba-856e-470f8b2a9bc7
```

Same UUID, so this is the original row rather than a re-seeded one. The data survived because
PostgreSQL's data directory is a **named volume** (`postgres-data:/var/lib/postgresql/data`),
whose lifecycle is independent of any container.

**Difference between `down`, `down -v`, and `stop`**

| Command | Containers | Network | Named volumes | Data |
|---|---|---|---|---|
| `docker compose stop` | stopped, kept | kept | kept | kept |
| `docker compose down` | stopped **and removed** | removed | **kept** | kept |
| `docker compose down -v` | stopped and removed | removed | **removed** | **destroyed** |

- **`stop`** — pause work and resume quickly. Containers keep their filesystem layer, so
  anything written outside a volume also survives. Use between working sessions.
- **`down`** — a clean teardown that still keeps state. This is the normal choice when
  changing `docker-compose.yml`, since containers must be recreated to pick up new settings,
  but the database should not be wiped. Note that container-local writes *are* lost here —
  only volumes persist.
- **`down -v`** — destroys the data. Legitimate uses: resetting to a known-clean state,
  re-running `init-db/init.sql` (which only executes when the data directory is empty), or
  freeing disk. In this project it was required once, when the PostgreSQL password changed:
  `POSTGRES_PASSWORD` is only read at initialisation, so an already-initialised volume keeps
  the old credentials and the new password appears to be ignored. **Never on production data.**

### 3.2 Volume inspection (4 pts)

```
$ docker volume inspect jobboard-postgres-data
[
    {
        "CreatedAt": "2026-08-05T05:13:55Z",
        "Driver": "local",
        "Labels": {
            "com.docker.compose.project": "jobboard",
            "com.docker.compose.volume": "postgres-data"
        },
        "Mountpoint": "/var/lib/docker/volumes/jobboard-postgres-data/_data",
        "Name": "jobboard-postgres-data",
        "Scope": "local"
    }
]
```

**Where is the data actually stored on the host?**

The reported mountpoint is `/var/lib/docker/volumes/jobboard-postgres-data/_data`, but that
path must be read carefully on this machine. This is Docker Desktop on Windows, so the Docker
Engine runs inside a Linux VM — the path is **inside that VM**, not on the Windows filesystem,
and there is no `C:\var\lib\docker` to browse. On a native Linux host the same path would be
directly accessible (as root). The portable way to reach the contents from anywhere is to
mount the volume into a throwaway container:

```
$ docker run --rm -v jobboard-postgres-data:/data alpine sh -c "ls /data; du -sh /data"
PG_VERSION  base  global  pg_commit_ts  pg_dynshmem  pg_hba.conf  ...
46.2M	/data
```

**Named volume vs bind mount**

| | Named volume (`postgres-data:/var/lib/postgresql/data`) | Bind mount (`./data:/var/lib/postgresql/data`) |
|---|---|---|
| Location | Docker-managed storage area | An exact host path you choose |
| Created by | Docker, on demand | Must already exist on the host |
| Portability | Works identically on Linux/macOS/Windows | Path and permissions are host-specific |
| Permissions | Docker sets ownership to match the container | Host UID/GID must line up, a frequent source of `permission denied` |
| Performance | Native speed | Native on Linux, but slow on Docker Desktop, where it crosses a VM boundary |
| Driver support | Can use plugins (NFS, cloud volumes) | Local filesystem only |
| Backup | Via `docker run --rm -v vol:/data ...` | Copy the directory directly |

**When to prefer each in production**

Use a **named volume** for database storage — which is what this project does. It keeps the
container runtime in charge of permissions, works the same across hosts and CI, can be backed
by a driver that survives node loss, and is not accidentally deleted by someone cleaning a
project directory.

Use a **bind mount** when the host path is the point: injecting read-only configuration (this
project bind-mounts `./init-db/init.sql` into the entrypoint directory, correctly with `:ro`),
exposing logs to a host collector, or mounting source code for live reload in development.
For production *data*, a bind mount ties the container to one specific machine and is the
usual cause of "works on my laptop" permission failures.

The distinction is visible in this very compose file, which uses both appropriately: a named
volume for the data directory, and a read-only bind mount for the seed script.

### 3.3 Database backup and restore (6 pts)

**Backup**

```
$ docker exec jobboard-db pg_dump -U postgres -d jobboard --no-owner --no-acl -F plain \
    > backup_20260805_081937.sql
created: backup_20260805_081937.sql (4759 bytes)
```

`--no-owner` and `--no-acl` strip `OWNER TO` and `GRANT` statements, so the dump restores
cleanly into a database whose role names differ from the source — which is exactly what makes
the restore below work against a container using a different password.

**A correction to the lab's verification step.** The instructions suggest
`grep -c "INSERT INTO" backup_*.sql`, which returns **0** here. That is not a failed backup —
`pg_dump` emits bulk `COPY` blocks rather than per-row `INSERT` statements by default, because
`COPY` restores dramatically faster. Verify with `COPY` instead, or regenerate the dump with
`--column-inserts` if INSERT statements are genuinely wanted:

```
$ grep -c "INSERT INTO" backup_*.sql     ->  0    (expected: pg_dump uses COPY)
$ grep -c "^COPY "      backup_*.sql     ->  2    (jobs + applications)
$ rows in the public.jobs COPY block     ->  6
```

**Restore procedure — executed, not just documented** (`evidence/08-restore.txt`)

```bash
# 1. Start a clean postgres container on an empty volume
docker run -d --name jobboard-db-restore \
  -e POSTGRES_PASSWORD=restore-test-pw \
  -e POSTGRES_DB=jobboard \
  -e POSTGRES_USER=postgres \
  -v jobboard-restore-test:/var/lib/postgresql/data \
  postgres:16-alpine

# wait until it accepts connections
until docker exec jobboard-db-restore pg_isready -U postgres -d jobboard; do sleep 2; done

# 2. Copy the SQL file into the container
docker cp backup_20260805_081937.sql jobboard-db-restore:/tmp/restore.sql

# 3. Run psql inside the container. ON_ERROR_STOP=1 is important: without it psql
#    reports success even if individual statements failed.
docker exec jobboard-db-restore \
  psql -U postgres -d jobboard -v ON_ERROR_STOP=1 -f /tmp/restore.sql
```

Verified empty beforehand (`\dt` → `Did not find any relations.`) and after restoring:

```
SET / CREATE TABLE / CREATE TABLE / COPY 0 / COPY 6 / ALTER TABLE ... / CREATE INDEX ...

 job_count            live_job_count
-----------           --------------
         6                        6

             title             |      company
-------------------------------+-------------------
 Senior DevOps Engineer        | TechCorp Ltd.
 Backend Developer (Python)    | StartupXYZ
 Cloud Architect               | CloudSystems Inc.
 Frontend Engineer (React)     | ProductLab
 Security Engineer (DevSecOps) | SecureOps
 Persistence Test Job          | Lab Inc
```

The restored database matches the live one exactly, including the row created in Task 3.1.

> Practical note for Git Bash on Windows: `docker exec ... -f /tmp/restore.sql` fails with
> `No such file or directory` because MSYS rewrites `/tmp/...` into a Windows path before
> Docker sees it. Prefix the command with `MSYS_NO_PATHCONV=1`.

---

## Task 5 — Networking & Service Communication (10 pts)

### 5.1 Understanding the Docker network (4 pts)

```
$ docker network inspect jobboard-network
Name:    jobboard-network
Driver:  bridge
Scope:   local
Subnet:  172.20.0.0/16   Gateway: 172.20.0.1
```

**Containers on the network and their addresses:**

| Container | IPv4 | MAC |
|---|---|---|
| `jobboard-db` | 172.20.0.2/16 | b2:4d:1d:67:13:23 |
| `applications-service` | 172.20.0.3/16 | 86:33:07:7a:26:11 |
| `jobs-service` | 172.20.0.4/16 | 12:29:b0:0c:96:d3 |
| `jobboard-frontend` | 172.20.0.5/16 | aa:fd:31:5e:df:62 |
| `nginx-proxy` | 172.20.0.6/16 | b6:0c:85:58:ad:af |

Addresses were handed out in dependency order, which is a direct consequence of the
`depends_on` gating in Task 2.3. They are **not** stable across recreation, which is precisely
why services address each other by name rather than by IP.

**How `jobs-service` resolves the hostname `postgres`**

Docker runs an embedded DNS server for every user-defined network. Each container's
`/etc/resolv.conf` points at it:

```
$ docker exec jobs-service cat /etc/resolv.conf
nameserver 127.0.0.11
options ndots:0
```

`127.0.0.11` is a loopback address inside the container's own network namespace; the daemon
intercepts queries there and answers from its record of container names, network aliases and
service names on `jobboard-network`. Anything it cannot answer is forwarded to the host's
resolver. Resolution verified from inside the container:

```
postgres               -> 172.20.0.2
applications-service   -> 172.20.0.3
nginx                  -> 172.20.0.6
frontend               -> 172.20.0.5
```

Note `nginx` and `frontend` resolve by **service** name while the containers are actually
named `nginx-proxy` and `jobboard-frontend` — Compose registers both the service name and the
`container_name` as aliases. This is what makes `upstream jobs_service { server jobs-service:8000; }`
work in `nginx.conf`. Critically, this only applies to user-defined networks: the legacy
default bridge has no embedded DNS and would require the deprecated `--link` flag.

**What happens if you try to reach `jobs-service:8000` from your browser directly? Why?**

It fails, in two independent ways:

```
$ curl http://jobs-service:8000/health   -> 000  (hostname does not resolve)
$ curl http://localhost:8000/health      -> 000  (connection refused)
```

1. **The name does not exist outside Docker.** `jobs-service` is a record in Docker's embedded
   DNS on `127.0.0.11`, reachable only from containers attached to `jobboard-network`. The
   host's resolver knows nothing about it.
2. **The port is not published.** Only nginx maps a port to the host:

   ```
   NAME                   PORTS
   applications-service   3001/tcp                 <- container-internal only
   jobboard-db            5432/tcp                 <- container-internal only
   jobs-service           8000/tcp                 <- container-internal only
   nginx-proxy            0.0.0.0:80->80/tcp       <- the only way in
   ```

   `EXPOSE`/the `PORTS` column here is documentation of what the container listens on; it does
   **not** open a host port. Without a `ports:` mapping there is no NAT rule forwarding host
   traffic to `172.20.0.4:8000`.

This is the intended design, and it is a security property rather than an inconvenience: the
database and both APIs have no host-reachable surface at all. Every external request must pass
through nginx, where rate limiting, security headers and routing are enforced in one place.

### 5.2 Inter-service communication test (3 pts)

```
$ docker exec jobs-service python3 -c "import psycopg2, os; conn = psycopg2.connect(...)"
Connected to PostgreSQL: {'host': 'postgres', 'port': '5432', 'dbname': 'jobboard', 'user': 'postgres'}
Server: PostgreSQL 16.14 on x86_64-pc-linux-musl, compiled by gcc
```

Note `x86_64-pc-linux-**musl**`, confirming the Alpine-based PostgreSQL image, and that the
Alpine-rebased `jobs-service` from Task 1 talks to it correctly through the compiled psycopg2.

Cross-service HTTP also works by name:

```
$ docker exec applications-service wget -qO- http://jobs-service:8000/health
{"status":"healthy","service":"jobs-service","version":"1.0.0"}
```

### 5.3 Nginx routing analysis (3 pts)

Full journey of `POST http://localhost/api/applications/` (`evidence/11-routing-trace.txt`):

**1. Which `location` block matches**

nginx selects `location /api/applications`. Both `/api/jobs` and `/api/applications` are
prefix locations; nginx picks the longest matching prefix, and since there is no regex
location, that choice is final. The catch-all `location /` is not used because it is a shorter
prefix.

**2. What the rewrite transforms the path to**

```nginx
rewrite ^/api/applications/(.*) /applications/$1 break;
rewrite ^/api/applications$     /applications    break;
```

`/api/applications/` matches the first rule with an empty capture group, giving
**`/applications/`**. `break` stops rewrite processing and keeps the request in this location
block. Express mounts the router at `/applications` and treats `/applications` and
`/applications/` as the same route, so the trailing slash is harmless here — unlike the
jobs-service, where the identical pattern caused the 307 redirect documented in the pre-work
section.

**3. Which upstream container receives it, on which port**

`proxy_pass http://applications_service;` resolves the upstream block
`upstream applications_service { server applications-service:3001; }` → via embedded DNS to
**172.20.0.3:3001** — the `applications-service` container. nginx also applies
`limit_req zone=api burst=20 nodelay` (30 req/min per client IP) before proxying, and sets
`Host`, `X-Real-IP` and `X-Forwarded-For` so the upstream can see the true client address.

**4. How the response travels back**

`routes/applications.js` validates the payload, `INSERT ... RETURNING *` writes the row, and
Express replies `201` with the created JSON. nginx relays it to the browser, adding the
`server`-level security headers. Observed response:

```
< HTTP/1.1 201 Created
< Server: nginx/1.27.5
< Content-Type: application/json; charset=utf-8
< X-Powered-By: Express                 <- proves the Node upstream served it
< Access-Control-Allow-Origin: *
< X-Frame-Options: SAMEORIGIN
< X-Content-Type-Options: nosniff
< X-XSS-Protection: 1; mode=block
```

Confirmed persisted:

```
$ docker exec jobboard-db psql -U postgres -d jobboard -c "SELECT applicant_name, status FROM applications ..."
 applicant_name | applicant_email | status
----------------+-----------------+---------
 Trace User     | trace@lab.com   | pending
```

> Operational note: `docker exec nginx-proxy tail -f /var/log/nginx/access.log` hangs forever.
> In the official nginx image that file is a symlink to `/dev/stdout`
> (`access.log -> /dev/stdout`), so reading it blocks. Use `docker compose logs nginx`, which
> is also what makes the `json-file` log rotation from Task 2.1 apply to nginx's access log.

---

## Task 6 — Security Hardening (Bonus — 10 pts)

### 6.1 Use Docker secrets (5 pts)

Implemented as an **overlay** (`docker-compose.secrets.yml`) rather than by editing the base
file, so the stack Tasks 1–5 are graded against stays intact:

```bash
echo "S3cr3t-Doc.k3r~Pa55w0rd!x" > db_password.txt        # gitignored
docker compose -f docker-compose.yml -f docker-compose.secrets.yml up -d
```

**A Compose merge subtlety worth recording.** The obvious way to drop the inherited
`POSTGRES_PASSWORD` is `POSTGRES_PASSWORD: null` in the override — but Compose *keeps the base
value*, and the container then fails:

```
jobboard-db  | error: both POSTGRES_PASSWORD and POSTGRES_PASSWORD_FILE are set (but are exclusive)
```

Removing an inherited key requires the `!reset` tag (Compose ≥ 2.24):

```yaml
POSTGRES_PASSWORD: !reset null
DATABASE_URL:      !reset null
```

Verified in the merged config — neither `POSTGRES_PASSWORD` nor `DATABASE_URL` survives, only
the `_FILE` pointers.

**Application changes.** Both services now read the password from disk and assemble the
connection string themselves:

- `jobs-service/app/database.py` → `build_database_url()`
- `applications-service/src/db.js` → `buildConnectionString()`

Both follow the same rules:

1. If `DB_PASSWORD_FILE` is set, read that file and build the URL from the surrounding
   `POSTGRES_*` variables; otherwise fall back to `DATABASE_URL`. The service therefore works
   unchanged in both the base and the secrets stack, and in Kubernetes, because it only ever
   depends on *a file path*.
2. **Credentials are percent-encoded** (`urllib.parse.quote` / `encodeURIComponent`). This is
   not cosmetic: Task 2.2 had to hand-pick a password avoiding `@ : / #` because those are URI
   delimiters. The whole point of a secret is that its contents are not under our control, so
   the code must encode rather than assume.
3. **The hard-coded fallback was deleted.** Both modules previously defaulted to
   `postgresql://postgres:jobboard123@localhost:5432/jobboard` — a real password in source
   control that also silently masked misconfiguration. A missing configuration now raises
   immediately.

**Verification** (`evidence/13-secrets.txt`) — all five containers healthy, full read and
write path exercised:

```
GET /api/jobs/ -> 200 ; jobs seeded: 5
write path via secret OK, application id: 075b2f02-20c0-4e80-81d3-071e55e127a2
```

The password is genuinely gone from the process environment:

```
jobboard-db:          no PASSWORD= or DATABASE_URL= in env (only *_FILE pointers)
jobs-service:         no PASSWORD= or DATABASE_URL= in env (only *_FILE pointers)
applications-service: no PASSWORD= or DATABASE_URL= in env (only *_FILE pointers)

$ docker exec jobs-service env | grep -E "DB_PASSWORD_FILE|POSTGRES_"
DB_PASSWORD_FILE=/run/secrets/db_password
POSTGRES_DB=jobboard
POSTGRES_HOST=postgres
POSTGRES_PORT=5432
POSTGRES_USER=postgres

$ docker inspect jobs-service | grep -c "S3cr3t-Doc.k3r"
0
```

That last line is the point of the exercise. With `.env` alone the password is in
`POSTGRES_PASSWORD`, and anyone able to run `docker inspect` — or read `/proc/<pid>/environ`
from a process sharing the namespace — can recover it. Environment variables are also
inherited by every child process and are routinely captured verbatim by crash reporters and
log shippers. A file read once at startup has none of those exposure paths.

**An honest limitation of file secrets under Compose.** Compose is not Swarm, and the
implementation differs:

```
$ docker inspect jobs-service --format '{{range .Mounts}}...'
bind  C:\Users\EladGal\projects\lab-job-board\db_password.txt -> /run/secrets/db_password  rw=false

$ docker exec jobs-service ls -l /run/secrets/
-rwxrwxrwx  1 root root 25 Aug  5 05:29 db_password
```

It is a **read-only bind mount of a plaintext file on the host**, not a tmpfs-delivered
secret. So this improves *exposure* (out of the environment, out of `docker inspect`) but not
*at-rest secrecy* — the password still sits unencrypted on the developer's disk, and Compose
does not tighten the file mode the way Swarm does (Swarm mounts secrets in tmpfs at `0444` and
they never touch the node's disk). The permissive `0777` above comes from the Windows 9p/drvfs
translation layer rather than from Docker. For real deployments the same code works unchanged
against Swarm secrets, Kubernetes secrets mounted as volumes (see `SOLUTION-k8s.md`), or a
Vault agent sidecar — because the contract is only ever "read this path".

### 6.2 Content Security Policy headers (5 pts)

Added at the `server` level in `nginx/nginx.conf` so it covers every route:

```nginx
add_header Content-Security-Policy "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'self'; form-action 'self'" always;
```

Against the three required rules:

| Requirement | Directive | Notes |
|---|---|---|
| Scripts only from `self` | `script-src 'self'` | No inline `<script>`, no `eval`, no CDNs. Vite emits external bundles, so no relaxation was needed. |
| Styles from `self` and inline | `style-src 'self' 'unsafe-inline'` | `'unsafe-inline'` is required because React writes element `style` attributes at runtime. |
| Block all `frame-ancestors` | `frame-ancestors 'none'` | No origin may frame the app. |

Additional directives beyond the requirement: `default-src 'self'` as a backstop for anything
not named, `img-src 'self' data:` because the build inlines small images as data URIs,
`connect-src 'self'` to confine XHR/fetch to the `/api` routes, `object-src 'none'` to remove
the legacy plugin surface, `base-uri 'self'` so an injected `<base>` cannot re-target relative
URLs, and `form-action 'self'` so forms cannot post cross-origin.

`'unsafe-inline'` on `style-src` is the one deliberate weakening and should be called out
rather than glossed over: it permits injected inline styles, which enables CSS-based data
exfiltration and UI-redressing attacks. Removing it needs nonce- or hash-based styles, which
cannot be expressed in a static header and would require build integration.

`frame-ancestors 'none'` supersedes the pre-existing `X-Frame-Options: SAMEORIGIN`. Both are
sent; where they disagree, modern browsers honour the CSP directive, so the effective policy
is the stricter `'none'`.

**Verification** (`evidence/12-csp.txt`):

```
$ curl -sI http://localhost | grep -i content-security
Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'self'; form-action 'self'
```

The policy was also confirmed not to break the app: the page loads with **6 open positions
rendered and zero console messages**, so nothing is being blocked in practice.

> Minor observation: `X-Frame-Options` and `X-Content-Type-Options` are each returned twice,
> because both the proxy (`nginx/nginx.conf`) and the frontend's own server block
> (`frontend/nginx.conf`) add them. Duplicated identical values are harmless, but the tidier
> arrangement is to set security headers only at the edge proxy.

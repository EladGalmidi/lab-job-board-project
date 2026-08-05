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

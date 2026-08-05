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

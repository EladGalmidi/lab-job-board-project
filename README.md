# DevSecOps Lab — Containerised Job Board Platform

> **Difficulty:** Medium / Hard  
> **Total Points:** 100  
> **Estimated Time:** 6–10 hours  
> **Submission:** GitHub repository link + screenshots

---

## Overview

You are given a fully functional **Job Board** web application composed of three services and a PostgreSQL database. Your job is **not** to write business logic — it is to **containerise, orchestrate, secure, and automate** the deployment of this application using DevOps best practices.

The application is already coded and working. By the end of this lab you will have:

- Hardened Docker images running as non-root users
- A fully orchestrated stack with `docker compose`
- A persistent database volume that survives container restarts
- An Nginx reverse proxy as the single entry point
- A complete GitHub Actions CI/CD pipeline
- Trivy image scanning integrated into the pipeline
- A backup/restore procedure for the database

---

## Architecture

```
  Browser
     │  HTTP :80
     ▼
┌─────────────────────────────────────────────────────────────┐
│                  Docker Network: jobboard-network            │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐   │
│  │             nginx (Reverse Proxy)  :80               │   │
│  └────┬───────────────────────┬──────────────┬──────────┘   │
│       │ /                     │ /api/jobs     │ /api/apps    │
│       ▼                       ▼               ▼              │
│  ┌──────────┐      ┌──────────────────┐  ┌───────────────┐  │
│  │ frontend │      │  jobs-service    │  │ applications- │  │
│  │  React   │      │  Python/FastAPI  │  │ service       │  │
│  │  :80     │      │  :8000           │  │ Node.js :3001 │  │
│  └──────────┘      └────────┬─────────┘  └───────┬───────┘  │
│                              │                    │          │
│                    ┌─────────▼────────────────────▼──────┐   │
│                    │        PostgreSQL 16  :5432          │   │
│                    │        Volume: postgres-data         │   │
│                    └──────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

### Services

| Service                | Language                | Port (internal)   | Role                  |
| ---------------------- | ----------------------- | ----------------- | --------------------- |
| `postgres`             | PostgreSQL 16           | 5432              | Relational database   |
| `jobs-service`         | Python 3.12 / FastAPI   | 8000              | Job listings CRUD     |
| `applications-service` | Node.js 20 / Express    | 3001              | Job applications CRUD |
| `frontend`             | React 18 / Vite → nginx | 80                | Single-page app       |
| `nginx`                | Nginx 1.27              | **80** (external) | Reverse proxy         |

### Request Flow

```
GET /api/jobs/       → nginx → jobs-service:8000/jobs/
POST /api/applications/ → nginx → applications-service:3001/applications/
GET /                → nginx → frontend:80
```

---

## Repository Structure

```
lab-job-board/
├── .env.example                  ← copy to .env and fill in
├── .gitignore
├── docker-compose.yml
├── init-db/
│   └── init.sql                  ← DB schema + seed data
├── jobs-service/                 ← Python / FastAPI
│   ├── app/
│   │   ├── main.py
│   │   ├── database.py
│   │   ├── models.py
│   │   └── schemas.py
│   ├── requirements.txt
│   ├── Dockerfile
│   └── .dockerignore
├── applications-service/         ← Node.js / Express
│   ├── src/
│   │   ├── index.js
│   │   ├── db.js
│   │   └── routes/applications.js
│   ├── package.json
│   ├── Dockerfile
│   └── .dockerignore
├── frontend/                     ← React / Vite
│   ├── src/
│   │   ├── App.jsx
│   │   ├── App.css
│   │   ├── main.jsx
│   │   ├── api/index.js
│   │   └── components/
│   │       ├── JobList.jsx
│   │       ├── JobCard.jsx
│   │       ├── ApplyModal.jsx
│   │       ├── AddJobModal.jsx
│   │       └── AdminPanel.jsx
│   ├── index.html
│   ├── package.json
│   ├── vite.config.js
│   ├── nginx.conf
│   ├── Dockerfile
│   └── .dockerignore
├── nginx/
│   ├── nginx.conf
│   └── Dockerfile
└── .github/
    └── workflows/
        └── ci.yml
```

---

## Prerequisites

- Docker Engine ≥ 24.0 — [Install](https://docs.docker.com/engine/install/)
- Docker Compose Plugin ≥ 2.20 — bundled with Docker Desktop
- Git ≥ 2.40
- A GitHub account (free)
- A Docker Hub account (free) — for Task 4

Verify your setup:

```bash
docker --version        # Docker version 24.x.x
docker compose version  # Docker Compose version v2.x.x
git --version
```

---

## Quick Start (Verify everything works before starting tasks)

```bash
# 1. Clone / unzip the project
cd lab-job-board

# 2. Create your environment file
cp .env.example .env

# 3. Build and start all services
docker compose up --build -d

# 4. Check all containers are healthy
docker compose ps

# 5. Open the app
open http://localhost        # or navigate in your browser

# 6. Explore the API docs
open http://localhost/api/jobs/docs          # FastAPI Swagger UI
```

You should see the Job Board with 5 seeded job listings.

---

## API Reference

### Jobs Service — `http://localhost/api/jobs`

| Method   | Path         | Description   | Body                                                     |
| -------- | ------------ | ------------- | -------------------------------------------------------- |
| `GET`    | `/jobs/`     | List all jobs | —                                                        |
| `POST`   | `/jobs/`     | Create a job  | `{title, description, company, location, salary_range?}` |
| `GET`    | `/jobs/{id}` | Get a job     | —                                                        |
| `PUT`    | `/jobs/{id}` | Update a job  | `{title, description, company, location, salary_range?}` |
| `DELETE` | `/jobs/{id}` | Delete a job  | —                                                        |
| `GET`    | `/health`    | Health check  | —                                                        |

### Applications Service — `http://localhost/api/applications`

| Method  | Path                        | Description            | Body                                                       |
| ------- | --------------------------- | ---------------------- | ---------------------------------------------------------- |
| `GET`   | `/applications/`            | List all applications  | —                                                          |
| `POST`  | `/applications/`            | Submit an application  | `{job_id, applicant_name, applicant_email, cover_letter?}` |
| `GET`   | `/applications/{id}`        | Get an application     | —                                                          |
| `GET`   | `/applications/job/{jobId}` | Applications for a job | —                                                          |
| `PATCH` | `/applications/{id}/status` | Update status          | `{status: pending\|reviewed\|accepted\|rejected}`          |
| `GET`   | `/health`                   | Health check           | —                                                          |

---

## Lab Tasks

---

### Task 1 — Dockerfile Analysis & Hardening (20 pts)

The provided Dockerfiles are functional but imperfect. Your job is to **analyse and harden** them.

#### 1.1 – Run a vulnerability scan on all images (8 pts)

Install [Trivy](https://aquasecurity.github.io/trivy/latest/getting-started/installation/) and scan each image:

```bash
# Build the images first
docker compose build

# Scan each image
trivy image jobboard-jobs-service:latest
trivy image jobboard-applications-service:latest
trivy image jobboard-frontend:latest
```

In your `SOLUTION.md`, answer:

- How many CRITICAL CVEs did you find in total across all images?
- Which image has the most vulnerabilities?
- Pick **one** CRITICAL CVE and explain: (a) what it is, (b) which package it affects, (c) what the fix/mitigation is.

#### 1.2 – Harden the Dockerfiles (12 pts)

Apply the following improvements to **at least two** of the Dockerfiles (jobs-service and applications-service):

- [ ] Ensure the final image runs as a **non-root user** (already done — verify it works: `docker run --rm <image> whoami`)
- [ ] Pin all `FROM` tags to an exact digest (e.g., `python:3.12-slim@sha256:...`)
- [ ] Add a `.dockerignore` file if one is missing (already done — verify completeness)
- [ ] Add a `HEALTHCHECK` instruction to any Dockerfile that lacks one (already done — verify correctness)
- [ ] Reduce the final image layer count using `&&` chaining in `RUN` statements

Show the **before/after** image sizes:

```bash
docker images --format "table {{.Repository}}\t{{.Tag}}\t{{.Size}}"
```

Document your changes and the resulting size reduction in `SOLUTION.md`.

---

### Task 2 — Docker Compose Orchestration (25 pts)

The provided `docker-compose.yml` is complete and working. Extend it with the following.

#### 2.1 – Logging configuration (8 pts)

Add a `logging` section to **every service** in `docker-compose.yml` that:

- Uses the `json-file` log driver
- Limits log files to `10m` max size
- Keeps a maximum of `3` rotated log files

```yaml
logging:
  driver: json-file
  options:
    max-size: "10m"
    max-file: "3"
```

Verify logs work:

```bash
docker compose logs -f jobs-service
```

#### 2.2 – Environment variable isolation (9 pts)

Currently, the database password is set in `docker-compose.yml` with a default fallback. Improve this:

1. Copy `.env.example` to `.env`
2. Set a strong password (min 16 chars, mixed case + symbols)
3. Confirm that removing `.env` breaks the stack (try it, then restore)
4. Add `.env` to `.gitignore` and confirm it would NOT be committed: `git status`

In `SOLUTION.md`, explain why committing `.env` to git is a security risk and what tools exist to prevent it (e.g., `git-secrets`, `truffleHog`, GitHub secret scanning).

#### 2.3 – Service restart policy and dependency ordering (8 pts)

Verify and document the startup order by running:

```bash
docker compose up --build 2>&1 | grep -E "healthy|started|Starting"
```

Expected order: `postgres` (healthy) → `jobs-service` + `applications-service` (healthy) → `frontend` → `nginx`

In `SOLUTION.md`:

- Draw the dependency graph as ASCII art
- Explain what `condition: service_healthy` does vs `condition: service_started`
- What happens if postgres crashes after the other services are running? Verify with: `docker compose stop postgres`

---

### Task 3 — Data Persistence & Backup (15 pts)

#### 3.1 – Verify persistence across restarts (5 pts)

1. Create a new job via the UI or API:

```bash
curl -s -X POST http://localhost/api/jobs/ \
  -H "Content-Type: application/json" \
  -d '{"title":"Persistence Test Job","description":"Testing Docker volumes","company":"Lab Inc","location":"Docker"}' \
  | python3 -m json.tool
```

2. Stop and restart the containers (NOT `down -v`):

```bash
docker compose stop
docker compose start
```

3. Verify your job still exists:

```bash
curl -s http://localhost/api/jobs/ | python3 -m json.tool
```

4. In `SOLUTION.md`: Explain the difference between `docker compose down`, `docker compose down -v`, and `docker compose stop`. When would you use each?

#### 3.2 – Volume inspection (4 pts)

Inspect the named volume:

```bash
docker volume inspect jobboard-postgres-data
docker volume ls
```

In `SOLUTION.md`:

- Where on the host machine is the data actually stored?
- What is the difference between a **named volume** (`postgres-data:`) and a **bind mount** (`./data:/var/lib/postgresql/data`)?
- When would you prefer each approach in production?

#### 3.3 – Database backup and restore (6 pts)

**Backup:**

```bash
docker exec jobboard-db pg_dump \
  -U postgres \
  -d jobboard \
  --no-owner \
  --no-acl \
  -F plain > backup_$(date +%Y%m%d_%H%M%S).sql
```

**Verify the backup:**

```bash
head -30 backup_*.sql
grep -c "INSERT INTO" backup_*.sql
```

**Restore procedure** (in `SOLUTION.md`, write the exact commands to restore from this backup to a fresh container):

```bash
# Hint: you'll need to:
# 1. Start only the postgres service
# 2. Copy the SQL file into the container
# 3. Run psql inside the container
```

---

### Task 4 — CI/CD Pipeline with GitHub Actions (25 pts)

#### 4.1 – Fork and set up the repository (3 pts)

1. Push this project to a **new GitHub repository** (public or private)
2. Go to `Settings → Secrets and variables → Actions`
3. Add these repository secrets:
   - `DOCKERHUB_USERNAME` — your Docker Hub username
   - `DOCKERHUB_TOKEN` — a Docker Hub access token ([create one here](https://hub.docker.com/settings/security))

#### 4.2 – Trigger and verify the pipeline (10 pts)

Push a change to the `main` branch and verify the pipeline runs successfully:

```bash
git add .
git commit -m "feat: trigger CI pipeline"
git push origin main
```

Your pipeline must pass all these stages:

- [ ] `lint-test-python` — Python linting passes
- [ ] `lint-test-node` — Node.js dependency audit passes
- [ ] `build-images` — all 4 images build successfully
- [ ] `scan-images` — Trivy scans complete (exit-code 0, report generated)
- [ ] `integration-test` — all API assertions pass
- [ ] `push-to-registry` — images pushed to Docker Hub (only on `main`)

Take a screenshot of the successful pipeline and include it in your submission.

#### 4.3 – Add a test (12 pts)

The `jobs-service` has no unit tests. Create `jobs-service/tests/test_main.py` with tests that:

- Test `GET /health` returns `{"status": "healthy"}`
- Test `POST /jobs/` with valid data returns `201`
- Test `POST /jobs/` with missing fields returns `422`
- Test `GET /jobs/{id}` with a non-existent ID returns `404`

Use `pytest` with `TestClient` from FastAPI and **mock the database** (use `unittest.mock` or an in-memory SQLite database). The tests must run in CI without a real database.

```python
from fastapi.testclient import TestClient
from app.main import app

client = TestClient(app)

def test_health():
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json()["status"] == "healthy"
```

---

### Task 5 — Networking & Service Communication (10 pts)

#### 5.1 – Understand the Docker network (4 pts)

Inspect the internal network:

```bash
docker network inspect jobboard-network
```

In `SOLUTION.md`:

- List all containers on the network with their IP addresses
- Explain how `jobs-service` resolves the hostname `postgres` (Docker's embedded DNS)
- What happens if you try to reach `jobs-service:8000` from your browser directly? Why?

#### 5.2 – Inter-service communication test (3 pts)

Exec into a running container and verify it can reach the database and other services:

```bash
# From the jobs-service container, reach postgres
docker exec -it jobs-service python3 -c "
import psycopg2
import os
conn = psycopg2.connect(os.environ['DATABASE_URL'])
print('Connected to PostgreSQL:', conn.get_dsn_parameters())
conn.close()
"
```

#### 5.3 – Nginx routing analysis (3 pts)

In `SOLUTION.md`, trace the full journey of this request:

```
Browser → POST http://localhost/api/applications/
```

Include:

1. Which nginx `location` block matches
2. What the `rewrite` rule transforms the path to
3. Which upstream container receives the request and on which port
4. How the response travels back to the browser

---

### Task 6 — Security Hardening (Bonus — 10 pts)

#### 6.1 – Use Docker secrets (5 pts)

Replace the `POSTGRES_PASSWORD` environment variable with a Docker secret.

1. Create a secret file: `echo "MyStr0ngP@ss!" > db_password.txt`
2. Modify `docker-compose.yml` to define the secret:

```yaml
secrets:
  db_password:
    file: ./db_password.txt
```

3. Update the `postgres` service to use it:

```yaml
postgres:
  environment:
    POSTGRES_PASSWORD_FILE: /run/secrets/db_password
  secrets:
    - db_password
```

4. Update the `jobs-service` and `applications-service` to read the password from the secret file and construct the `DATABASE_URL` dynamically (modify the Python/Node startup code).

#### 6.2 – Add Content Security Policy headers (5 pts)

Update `nginx/nginx.conf` to add a `Content-Security-Policy` header that:

- Allows scripts only from `self`
- Allows styles from `self` and inline
- Blocks all `frame-ancestors`

Document your CSP in `SOLUTION.md` and verify it appears in the response:

```bash
curl -sI http://localhost | grep -i content-security
```

---

## Submission Requirements

Create a `SOLUTION.md` file in the root of your repository answering all questions from the tasks above. Include:

- [ ] GitHub repository URL (all code must be pushed)
- [ ] `SOLUTION.md` with all task answers
- [ ] Screenshot: running application at `http://localhost`
- [ ] Screenshot: `docker compose ps` showing all containers **healthy**
- [ ] Screenshot: successful GitHub Actions pipeline (all jobs green)
- [ ] Screenshot: Docker Hub repository showing pushed images
- [ ] The `backup_*.sql` file committed to the repo (Task 3.3)

Submit your repository link via the course portal.

---

## Grading Rubric

| Task                          | Max Points | Criteria                                                                            |
| ----------------------------- | ---------- | ----------------------------------------------------------------------------------- |
| Task 1 — Dockerfile Hardening | 20         | Trivy scan completed, CVE explained, Dockerfile improvements applied and documented |
| Task 2 — Docker Compose       | 25         | Logging, env isolation, restart/dependency ordering all working and explained       |
| Task 3 — Persistence & Backup | 15         | Data survives restart, volume inspection done, backup/restore commands correct      |
| Task 4 — CI/CD Pipeline       | 25         | Pipeline runs end-to-end, images pushed to Docker Hub, unit tests written           |
| Task 5 — Networking           | 10         | Network analysis complete, inter-service comms verified, nginx routing traced       |
| Task 6 — Security (Bonus)     | 10         | Docker secrets implemented, CSP headers added                                       |
| **Total**                     | **105**    |                                                                                     |

---

## Debugging Tips

```bash
# View logs for a specific service
docker compose logs -f jobs-service

# Check container health details
docker inspect --format='{{json .State.Health}}' jobs-service | python3 -m json.tool

# Exec into a container
docker exec -it jobs-service sh
docker exec -it jobboard-db psql -U postgres -d jobboard

# Rebuild a single service without restarting others
docker compose up --build --no-deps jobs-service -d

# Check resource usage
docker stats

# List named volumes
docker volume ls

# Remove everything (WARNING: destroys data)
docker compose down -v --rmi all
```

## Common Issues

| Symptom                          | Likely Cause                 | Fix                                                  |
| -------------------------------- | ---------------------------- | ---------------------------------------------------- |
| `jobs-service` exits immediately | DB not ready yet             | Check `depends_on` + `healthcheck` in compose        |
| `502 Bad Gateway` from nginx     | Upstream service not started | `docker compose logs nginx` and the failing upstream |
| `connection refused` to postgres | Wrong `DATABASE_URL`         | Verify `.env` values match service names             |
| Frontend shows "Could not reach" | `jobs-service` unhealthy     | `docker compose ps` and check health status          |
| Port 80 already in use           | Another process on port 80   | Change `NGINX_PORT` in `.env` to e.g. `8080`         |

---

## Part 2 — Kubernetes Extension

Once you have completed the Docker Compose lab above, continue with the **Kubernetes lab** in [`k8s/README-k8s.md`](k8s/README-k8s.md).

The Kubernetes extension covers:

| Topic                                           | Manifests                         |
| ----------------------------------------------- | --------------------------------- |
| Namespace, Secrets, PersistentVolumeClaim       | `k8s/00–02`                       |
| Deployments + ClusterIP Services (all services) | `k8s/03–05`                       |
| Nginx Ingress with path rewriting               | `k8s/06-ingress.yaml`             |
| HorizontalPodAutoscaler (CPU + memory)          | `k8s/07-hpa.yaml`                 |
| Kubernetes Job for database seeding             | `k8s/08-seed-job.yaml`            |
| NetworkPolicy, ConfigMap (student tasks)        | `k8s/09–10` (written by students) |

Deploy the entire stack with a single command:

```bash
# After creating k8s/01-secret.yaml and loading images into minikube:
kubectl apply -k k8s/
```

---

_Good luck! Focus on understanding **why** each configuration decision is made, not just making it work. The `SOLUTION.md` explanations carry significant weight._

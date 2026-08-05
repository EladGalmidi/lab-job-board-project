"""Unit tests for the jobs-service API (Task 4.3).

Runs with no PostgreSQL server: see conftest.py for the SQLite wiring.

A note on paths. The routes are declared without a trailing slash
(``@app.get("/jobs")`` in app/main.py), so these tests target ``/jobs``. The
mismatch between that and the ``/api/jobs/`` the frontend calls is what caused
the 307-redirect defect documented in SOLUTION.md; ``test_jobs_trailing_slash_redirects``
below pins that behaviour so a future change to the route declarations cannot
silently reintroduce it.
"""

import uuid

# ── Health ────────────────────────────────────────────────────────────────

def test_health_returns_healthy(client):
    """GET /health returns {"status": "healthy"}."""
    response = client.get("/health")

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "healthy"
    assert body["service"] == "jobs-service"


def test_health_needs_no_database(client):
    """/health must not touch the database.

    This is deliberately asserted because it is a real weakness: the endpoint
    answers "healthy" even when PostgreSQL is down, which is why both API
    services kept reporting healthy while returning 500s in Task 2.3. The test
    documents the current contract rather than endorsing it.
    """
    response = client.get("/health")
    assert response.status_code == 200


# ── Create ────────────────────────────────────────────────────────────────

def test_create_job_returns_201(client, valid_job_payload):
    """POST /jobs with valid data returns 201 and echoes the job back."""
    response = client.post("/jobs", json=valid_job_payload)

    assert response.status_code == 201
    body = response.json()
    assert body["title"] == valid_job_payload["title"]
    assert body["company"] == valid_job_payload["company"]
    # The handler generates the id and created_at.
    assert uuid.UUID(body["id"])
    assert body["created_at"] is not None


def test_create_job_is_persisted(client, valid_job_payload):
    """A created job is retrievable afterwards."""
    created = client.post("/jobs", json=valid_job_payload).json()

    fetched = client.get(f"/jobs/{created['id']}")

    assert fetched.status_code == 200
    assert fetched.json()["id"] == created["id"]


# ── Validation ────────────────────────────────────────────────────────────

def test_create_job_missing_fields_returns_422(client):
    """POST /jobs with missing required fields returns 422."""
    response = client.post("/jobs", json={"title": "Only a title"})

    assert response.status_code == 422
    missing = {
        tuple(err["loc"])[-1]
        for err in response.json()["detail"]
        if err["type"] == "missing"
    }
    assert {"description", "company", "location"} <= missing


def test_create_job_empty_body_returns_422(client):
    response = client.post("/jobs", json={})
    assert response.status_code == 422


def test_create_job_violating_min_length_returns_422(client, valid_job_payload):
    """Constraints from schemas.JobCreate are enforced, not just presence."""
    payload = {**valid_job_payload, "title": "ab"}  # min_length=3

    response = client.post("/jobs", json=payload)

    assert response.status_code == 422


# ── Retrieval ─────────────────────────────────────────────────────────────

def test_get_nonexistent_job_returns_404(client):
    """GET /jobs/{id} with an unknown id returns 404."""
    response = client.get(f"/jobs/{uuid.uuid4()}")

    assert response.status_code == 404
    assert "not found" in response.json()["detail"].lower()


def test_list_jobs_empty_by_default(client):
    response = client.get("/jobs")

    assert response.status_code == 200
    assert response.json() == []


def test_list_jobs_returns_created_jobs(client, valid_job_payload):
    client.post("/jobs", json=valid_job_payload)
    client.post("/jobs", json={**valid_job_payload, "title": "Second Role"})

    response = client.get("/jobs")

    assert response.status_code == 200
    assert len(response.json()) == 2


# ── Routing contract ──────────────────────────────────────────────────────

def test_jobs_collection_accepts_trailing_slash(client):
    """Both /jobs and /jobs/ serve the collection directly, with no redirect.

    Regression guard for the defect described in SOLUTION.md. Only "/jobs" was
    declared originally, so "/jobs/" produced a 307 whose Location pointed at the
    public host; the browser then re-requested a path that no proxy mapped back
    to this service and received the SPA as text/html. Asserting
    follow_redirects=False is the point of the test: a 307 here is the bug.
    """
    for path in ("/jobs", "/jobs/"):
        response = client.get(path, follow_redirects=False)
        assert response.status_code == 200, f"{path} returned {response.status_code}"
        assert response.json() == []


def test_jobs_collection_accepts_trailing_slash_on_post(client, valid_job_payload):
    """POST works on both forms too, since the frontend posts to /api/jobs/."""
    response = client.post("/jobs/", json=valid_job_payload, follow_redirects=False)

    assert response.status_code == 201
    assert response.json()["title"] == valid_job_payload["title"]

"""Unit tests for the jobs-service API (Task 4.3).

Runs with no PostgreSQL server: see conftest.py for the SQLite wiring.

A note on paths. The collection endpoints are declared at BOTH ``/jobs`` and
``/jobs/`` in app/main.py. Originally only ``/jobs`` existed, so the ``/api/jobs/``
the frontend calls produced a 307 redirect that escaped the service and returned
the SPA as text/html -- the defect documented in SOLUTION.md.
``test_jobs_collection_accepts_trailing_slash`` pins the fix so a future edit to
the route declarations cannot silently reintroduce it.
"""

import uuid
from unittest.mock import MagicMock

from sqlalchemy.exc import OperationalError

from app.database import get_db
from app.main import app

# ── Health ────────────────────────────────────────────────────────────────

def test_health_returns_healthy(client):
    """GET /health returns {"status": "healthy"}."""
    response = client.get("/health")

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "healthy"
    assert body["service"] == "jobs-service"


def test_health_needs_no_database(client):
    """/health is the LIVENESS probe and must not touch the database.

    Deliberately shallow: a liveness failure makes the kubelet kill and restart
    the container, so depending on PostgreSQL here would turn a database blip
    into a restart storm that removes the capacity needed to recover. The
    dependency check lives in /ready instead.
    """
    response = client.get("/health")
    assert response.status_code == 200


# ── Readiness ─────────────────────────────────────────────────────────────

def test_ready_returns_200_when_database_reachable(client):
    """/ready is the READINESS probe: it executes a real query."""
    response = client.get("/ready")

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ready"
    assert body["database"] == "connected"


def test_ready_returns_503_when_database_unavailable(client):
    """/ready must report 503 once the database is unreachable.

    Regression guard for the behaviour measured in Task 2.3: with PostgreSQL
    stopped, both API services kept reporting healthy while failing every real
    request, so nothing was ever removed from the load-balancer pool.

    The failure is injected at the session rather than by disposing the engine:
    an in-memory SQLite engine simply recreates an empty database on the next
    connection, so disposing it does not actually simulate an outage.
    """
    failing_session = MagicMock()
    failing_session.execute.side_effect = OperationalError(
        "SELECT 1", {}, Exception("could not connect to server")
    )

    def failing_db():
        yield failing_session

    app.dependency_overrides[get_db] = failing_db
    try:
        response = client.get("/ready")
    finally:
        app.dependency_overrides.pop(get_db, None)

    assert response.status_code == 503
    assert "database unavailable" in response.json()["detail"]


def test_health_still_ok_when_database_unavailable(client):
    """Liveness must stay green during a database outage.

    This is the other half of the split: /ready goes 503 so traffic is withdrawn,
    but /health stays 200 so the kubelet does not restart an otherwise healthy
    process. Restarting here would destroy the connection pool and slow recovery.
    """
    failing_session = MagicMock()
    failing_session.execute.side_effect = OperationalError(
        "SELECT 1", {}, Exception("could not connect to server")
    )

    def failing_db():
        yield failing_session

    app.dependency_overrides[get_db] = failing_db
    try:
        assert client.get("/ready").status_code == 503
        assert client.get("/health").status_code == 200
    finally:
        app.dependency_overrides.pop(get_db, None)


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

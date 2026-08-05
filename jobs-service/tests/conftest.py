"""Shared pytest fixtures for the jobs-service test suite.

The service must be testable without a PostgreSQL server, so the SQLAlchemy
session is redirected at an in-memory SQLite database.

Two details make that work:

1. ``DATABASE_URL`` is set *before* ``app.main`` is imported. Importing that
   module executes ``models.Base.metadata.create_all(bind=engine)`` at module
   scope, and ``app.database`` builds its engine at import time too, so waiting
   until after the import would be too late -- the real PostgreSQL URL would
   already have been resolved.

2. ``StaticPool`` plus ``check_same_thread=False``. An in-memory SQLite database
   normally lives and dies with a single connection, so each pooled connection
   would see a different, empty database. ``StaticPool`` reuses one connection
   for the whole engine, which is what keeps the schema and rows visible to
   both the fixture and the request handler running on TestClient's thread.
"""

import os

os.environ.setdefault("DATABASE_URL", "sqlite://")

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from sqlalchemy import create_engine  # noqa: E402
from sqlalchemy.orm import sessionmaker  # noqa: E402
from sqlalchemy.pool import StaticPool  # noqa: E402

from app.database import Base, get_db  # noqa: E402
from app.main import app  # noqa: E402


@pytest.fixture
def db_engine():
    """A fresh in-memory database per test, so tests cannot leak state."""
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(bind=engine)
    yield engine
    Base.metadata.drop_all(bind=engine)
    engine.dispose()


@pytest.fixture
def client(db_engine):
    """TestClient with get_db overridden to use the throwaway SQLite engine."""
    TestingSessionLocal = sessionmaker(
        autocommit=False, autoflush=False, bind=db_engine
    )

    def override_get_db():
        db = TestingSessionLocal()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = override_get_db
    with TestClient(app) as test_client:
        yield test_client
    app.dependency_overrides.clear()


@pytest.fixture
def valid_job_payload():
    """A payload satisfying every constraint in schemas.JobCreate."""
    return {
        "title": "Senior DevOps Engineer",
        "description": "Own the CI/CD platform and the Kubernetes estate.",
        "company": "TechCorp Ltd.",
        "location": "Remote",
        "salary_range": "$120,000 - $160,000",
    }

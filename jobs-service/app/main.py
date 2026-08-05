import os
import uuid

from fastapi import Depends, FastAPI, HTTPException, status
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from . import models, schemas
from .database import engine, get_db

models.Base.metadata.create_all(bind=engine)

app = FastAPI(
    title="Jobs Service",
    description="Microservice for managing job listings",
    version="1.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health", tags=["Health"])
def health_check():
    """Liveness: is this process alive and able to answer at all?

    Deliberately shallow -- it must NOT touch the database. A liveness probe
    failure causes the kubelet to KILL and restart the container, so making it
    depend on an external service turns a database blip into a cluster-wide
    restart storm that removes the very capacity needed to recover.

    Use /ready for the dependency check.

    APP_VERSION is baked in at build time (see the Dockerfile ARG), which makes a
    rolling update observable: probing this endpoint during a rollout shows the
    reported version flip while it keeps answering 200.
    """
    return {
        "status": "healthy",
        "service": "jobs-service",
        "version": os.getenv("APP_VERSION", "1.0.0"),
    }


@app.get("/ready", tags=["Health"])
def readiness_check(db: Session = Depends(get_db)):
    """Readiness: can this instance actually serve requests right now?

    Executes a real query, so the answer reflects the database dependency.
    Returning 503 removes the pod from the Service endpoints without restarting
    it, which is exactly the desired behaviour while PostgreSQL is unavailable --
    the pod stops receiving traffic and rejoins automatically once the query
    succeeds again.

    This exists because the original /health returned a hard-coded "healthy"
    regardless of database state, so both API services reported healthy while
    failing 100% of real requests with PostgreSQL down.
    """
    try:
        db.execute(text("SELECT 1"))
    except SQLAlchemyError as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=f"database unavailable: {exc.__class__.__name__}",
        ) from exc

    return {
        "status": "ready",
        "service": "jobs-service",
        "database": "connected",
    }


# The collection endpoints are registered at both "/jobs" and "/jobs/".
#
# Only "/jobs" was declared originally, so a request for "/jobs/" hit Starlette's
# redirect_slashes and came back as a 307 to "/jobs". Behind a proxy that is not
# a harmless redirect: the Location header is an absolute URL on the public host,
# so the browser re-requested "/jobs", which no longer matched the "/api/jobs"
# route in either the Compose nginx config or the Kubernetes ingress. It fell
# through to the catch-all and returned the React SPA as text/html instead of
# JSON, which broke the job list in the UI.
#
# The README's own API reference documents these endpoints *with* a trailing
# slash, and the frontend calls them that way (frontend/src/api/index.js), so
# accepting both forms is the correct fix and it removes the need for any proxy
# to compensate. Sub-paths such as /jobs/{job_id} were never affected.
@app.get("/jobs", response_model=list[schemas.Job], tags=["Jobs"])
@app.get("/jobs/", response_model=list[schemas.Job], tags=["Jobs"], include_in_schema=False)
def list_jobs(skip: int = 0, limit: int = 100, db: Session = Depends(get_db)):
    return db.query(models.Job).offset(skip).limit(limit).all()


@app.post("/jobs", response_model=schemas.Job, status_code=status.HTTP_201_CREATED, tags=["Jobs"])
@app.post(
    "/jobs/",
    response_model=schemas.Job,
    status_code=status.HTTP_201_CREATED,
    tags=["Jobs"],
    include_in_schema=False,
)
def create_job(job: schemas.JobCreate, db: Session = Depends(get_db)):
    db_job = models.Job(id=str(uuid.uuid4()), **job.model_dump())
    db.add(db_job)
    db.commit()
    db.refresh(db_job)
    return db_job


@app.get("/jobs/{job_id}", response_model=schemas.Job, tags=["Jobs"])
def get_job(job_id: str, db: Session = Depends(get_db)):
    job = db.query(models.Job).filter(models.Job.id == job_id).first()
    if not job:
        raise HTTPException(status_code=404, detail=f"Job '{job_id}' not found")
    return job


@app.put("/jobs/{job_id}", response_model=schemas.Job, tags=["Jobs"])
def update_job(job_id: str, updates: schemas.JobCreate, db: Session = Depends(get_db)):
    job = db.query(models.Job).filter(models.Job.id == job_id).first()
    if not job:
        raise HTTPException(status_code=404, detail=f"Job '{job_id}' not found")
    for field, value in updates.model_dump(exclude_unset=True).items():
        setattr(job, field, value)
    db.commit()
    db.refresh(job)
    return job


@app.delete("/jobs/{job_id}", status_code=status.HTTP_204_NO_CONTENT, tags=["Jobs"])
def delete_job(job_id: str, db: Session = Depends(get_db)):
    job = db.query(models.Job).filter(models.Job.id == job_id).first()
    if not job:
        raise HTTPException(status_code=404, detail=f"Job '{job_id}' not found")
    db.delete(job)
    db.commit()

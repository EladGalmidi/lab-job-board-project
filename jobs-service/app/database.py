import os
from urllib.parse import quote

from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, sessionmaker


def _read_secret(path: str) -> str:
    """Read a Docker secret from disk, failing loudly if it is unusable.

    Docker mounts secrets as files under /run/secrets/. Reading the password from
    a file rather than an environment variable matters because environment
    variables leak: they show up in `docker inspect`, in `/proc/<pid>/environ` to
    anything sharing the namespace, and they are inherited by every child process
    the service spawns.
    """
    try:
        with open(path, encoding="utf-8") as handle:
            secret = handle.read().strip()
    except OSError as exc:
        raise RuntimeError(f"DB_PASSWORD_FILE={path!r} could not be read: {exc}") from exc

    if not secret:
        raise RuntimeError(f"DB_PASSWORD_FILE={path!r} is empty")

    return secret


def _compose_url(password: str) -> str:
    """Assemble a connection URL from discrete parts, encoding the credentials.

    Percent-encoding is the whole point of this helper. A password containing
    @ : / ? or # corrupts the URI when interpolated naively, and neither a Docker
    secret nor a Kubernetes secret lets us constrain which characters it holds.
    """
    user = os.getenv("POSTGRES_USER", "postgres")
    database = os.getenv("POSTGRES_DB", "jobboard")
    host = os.getenv("POSTGRES_HOST", "postgres")
    port = os.getenv("POSTGRES_PORT", "5432")
    return (
        f"postgresql://{quote(user, safe='')}:{quote(password, safe='')}"
        f"@{host}:{port}/{database}"
    )


def build_database_url() -> str:
    """Resolve the database URL from whichever configuration style is present.

    Three modes, in precedence order:
      1. DB_PASSWORD_FILE -> read the password from that path (Docker secret, or
         a Kubernetes secret mounted as a volume) and compose the URL.
      2. DATABASE_URL     -> use it verbatim (the default Compose stack).
      3. POSTGRES_PASSWORD -> compose the URL from the discrete POSTGRES_* vars.

    Mode 3 exists because building the URL in YAML is unsafe. k8s/03-jobs-service.yaml
    originally did this:

        value: "postgresql://$(POSTGRES_USER):$(POSTGRES_PASSWORD)@postgres:5432/$(POSTGRES_DB)"

    Kubernetes performs plain textual substitution with no encoding, so a password
    generated the way k8s/README-k8s.md instructs -- `openssl rand -base64 20`,
    whose alphabet includes '+', '/' and '=' -- produces a malformed URI and the
    container dies with ERR_INVALID_URL. Letting the application compose the URL
    keeps the encoding responsibility in the one place that can do it correctly.

    There is deliberately no hard-coded fallback. The original module defaulted to
    a literal 'postgresql://postgres:jobboard123@localhost:5432/jobboard', which
    both masked a misconfigured deployment and committed a real password to
    source control.
    """
    password_file = os.getenv("DB_PASSWORD_FILE")
    if password_file:
        return _compose_url(_read_secret(password_file))

    url = os.getenv("DATABASE_URL")
    if url:
        return url

    password = os.getenv("POSTGRES_PASSWORD")
    if password:
        return _compose_url(password)

    raise RuntimeError(
        "No database configuration: set DB_PASSWORD_FILE, DATABASE_URL, or "
        "POSTGRES_PASSWORD (with the accompanying POSTGRES_* variables)."
    )


DATABASE_URL = build_database_url()

engine = create_engine(DATABASE_URL, pool_pre_ping=True)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


class Base(DeclarativeBase):
    pass


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

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


def build_database_url() -> str:
    """Resolve the database URL, preferring a Docker secret when one is configured.

    Two supported modes:
      * DB_PASSWORD_FILE set -> read the password from that file and assemble the
        URL from the surrounding POSTGRES_* variables (Task 6.1).
      * otherwise            -> use DATABASE_URL directly (the default stack).

    There is deliberately no hard-coded fallback. The original module defaulted to
    a literal 'postgresql://postgres:jobboard123@localhost:5432/jobboard', which
    both masked a misconfigured deployment and committed a real password to
    source control.
    """
    password_file = os.getenv("DB_PASSWORD_FILE")

    if password_file:
        password = _read_secret(password_file)
        user = os.getenv("POSTGRES_USER", "postgres")
        database = os.getenv("POSTGRES_DB", "jobboard")
        host = os.getenv("POSTGRES_HOST", "postgres")
        port = os.getenv("POSTGRES_PORT", "5432")
        # Percent-encode the credentials: a password containing @ : / or # would
        # otherwise corrupt the URI, and the point of a secret is that we do not
        # get to constrain which characters it contains.
        return (
            f"postgresql://{quote(user, safe='')}:{quote(password, safe='')}"
            f"@{host}:{port}/{database}"
        )

    url = os.getenv("DATABASE_URL")
    if not url:
        raise RuntimeError(
            "No database configuration: set DATABASE_URL, or set DB_PASSWORD_FILE "
            "to the path of a mounted Docker secret."
        )
    return url


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

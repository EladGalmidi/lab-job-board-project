# ── Stage 1: dependency installation ──────────────────────────
#
# Base changed from python:3.12-slim (Debian 13) to python:3.12-alpine.
# Measured with Trivy on this project:
#
#   python:3.12-slim   4 CRITICAL / 22 HIGH / 186 total    274 MB
#   python:3.12-alpine 0 CRITICAL /  3 HIGH /  13 total    172 MB
#
# All four CRITICALs on the Debian base were in perl-base 5.40.1-6
# (CVE-2026-13221, CVE-2026-42496, CVE-2026-57433, CVE-2026-8376) and Trivy
# reports no fixed version for any of them, so "apt-get upgrade" cannot clear
# them -- the base image itself had to change. Alpine also carries a far smaller
# package surface, which is where the remaining 173-vulnerability drop comes from.
#
# Pinned by digest so the build is reproducible: a tag like 3.12-alpine is
# mutable and silently moves, which would invalidate the scan recorded above.
#   docker buildx imagetools inspect python:3.12-alpine --format '{{.Manifest.Digest}}'
FROM python:3.12-alpine@sha256:6d43704baacd1bfbe7c295d7f13079d5d8104ed33568873133f8fc69980419df AS builder

WORKDIR /build

COPY requirements.txt .

# psycopg2-binary ships manylinux wheels only, so on musl it must be compiled.
# The toolchain goes into a virtual package that is deleted in the same layer,
# and none of it reaches the runtime stage anyway.
RUN apk add --no-cache --virtual .build-deps \
        gcc musl-dev postgresql-dev python3-dev && \
    pip install --no-cache-dir --prefix=/install -r requirements.txt && \
    apk del .build-deps

# ── Stage 2: lean runtime image ───────────────────────────────
FROM python:3.12-alpine@sha256:6d43704baacd1bfbe7c295d7f13079d5d8104ed33568873133f8fc69980419df

LABEL maintainer="DevSecOps Lab"
LABEL service="jobs-service"

WORKDIR /app

# Security updates, the libpq runtime that psycopg2 links against, and the
# unprivileged account -- all in one layer so no intermediate state is kept.
# UID/GID are pinned to 1000 rather than left to "adduser -S" (which allocates
# from the 100-999 system range) because k8s/03-jobs-service.yaml sets
# runAsUser: 1000 and the two must agree.
RUN apk update && \
    apk upgrade --no-cache && \
    apk add --no-cache libpq && \
    addgroup -S -g 1000 appgroup && \
    adduser -S -u 1000 -G appgroup appuser && \
    rm -rf /var/cache/apk/*

COPY --from=builder /install /usr/local
# --chown on COPY sets ownership as the layer is written; a separate
# "RUN chown -R" would duplicate the whole tree into an extra layer.
COPY --chown=appuser:appgroup app/ ./app/

USER appuser

EXPOSE 8000

# 127.0.0.1 rather than localhost: uvicorn binds IPv4 only (--host 0.0.0.0).
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health')"

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]

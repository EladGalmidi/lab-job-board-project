# Digest-pinned for reproducibility (see jobs-service/Dockerfile for rationale).
FROM nginx:1.27-alpine@sha256:65645c7bb6a0661892a8b03b89d0743208a18dd2f3f17a54ef4b76fb8e2f2a10

LABEL maintainer="DevSecOps Lab"
LABEL service="nginx-proxy"

RUN apk update && apk upgrade --no-cache

COPY nginx.conf /etc/nginx/nginx.conf

EXPOSE 80

# Probe 127.0.0.1, not localhost: nginx listens IPv4-only ("listen 80;"), while
# localhost resolves to ::1 first inside the container and busybox wget does not
# fall back to IPv4 -- so a localhost probe always fails "Connection refused".
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -q --spider http://127.0.0.1:80/api/jobs/ || exit 1

CMD ["nginx", "-g", "daemon off;"]

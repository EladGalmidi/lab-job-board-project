# ── Stage 1: install production dependencies ──────────────────
# Base pinned by digest for reproducibility. Resolved with:
#   docker buildx imagetools inspect node:20-alpine --format '{{.Manifest.Digest}}'
FROM node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293 AS deps

WORKDIR /app

COPY package*.json ./

# --omit=dev replaces the deprecated --only=production (npm 9+).
# npm ci installs strictly from package-lock.json, so the dependency tree is
# identical on every build.
RUN npm ci --omit=dev && npm cache clean --force

# ── Stage 2: lean runtime image ───────────────────────────────
FROM node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293

LABEL maintainer="DevSecOps Lab"
LABEL service="applications-service"

WORKDIR /app

# Apply Alpine security updates and delete npm/corepack in a single layer.
#
# Removing npm is the highest-value change here. Trivy on the original image
# reported 1 CRITICAL and 17 HIGH, and every one came from libraries bundled
# inside npm itself (tar, sigstore, glob, minimatch, cross-spawn,
# brace-expansion, ip-address) under /usr/local/lib/node_modules/npm -- not from
# this service's 85 production dependencies, which scanned clean. The container
# starts with "node src/index.js" and never invokes npm, so removing it takes
# those CVEs to zero and shrinks the image at no functional cost.
#
# No user is created: the official Node image already ships an unprivileged
# "node" account at UID/GID 1000, which is exactly what
# k8s/04-applications-service.yaml pins via runAsUser: 1000. Creating a second
# account at the same UID would fail the build, and creating one at a different
# UID would contradict the manifest.
RUN apk update && \
    apk upgrade --no-cache && \
    rm -rf /usr/local/lib/node_modules/npm \
           /usr/local/lib/node_modules/corepack \
           /usr/local/bin/npm \
           /usr/local/bin/npx \
           /usr/local/bin/corepack \
           /root/.npm \
           /var/cache/apk/*

# --chown during COPY avoids a duplicate "RUN chown -R" layer over node_modules.
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node src/ ./src/
COPY --chown=node:node package.json ./

USER node

EXPOSE 3001

# 127.0.0.1 rather than localhost, for consistency with the other services.
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
    CMD wget -q --spider http://127.0.0.1:3001/health || exit 1

CMD ["node", "src/index.js"]

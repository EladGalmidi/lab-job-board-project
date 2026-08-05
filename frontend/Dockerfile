# ── Stage 1: build the React app ──────────────────────────────
FROM node:20-alpine AS builder

RUN apk update && apk upgrade --no-cache

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

# ── Stage 2: serve with nginx ─────────────────────────────────
FROM nginx:1.27-alpine

LABEL maintainer="DevSecOps Lab"
LABEL service="frontend"

RUN apk update && apk upgrade --no-cache

COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

# Probe 127.0.0.1, not localhost -- see nginx/Dockerfile for the IPv6 rationale.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -q --spider http://127.0.0.1:80 || exit 1

CMD ["nginx", "-g", "daemon off;"]

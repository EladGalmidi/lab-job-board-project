FROM nginx:1.27-alpine

LABEL maintainer="DevSecOps Lab"
LABEL service="nginx-proxy"

RUN apk update && apk upgrade --no-cache

COPY nginx.conf /etc/nginx/nginx.conf

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -q --spider http://localhost:80/api/jobs/ || exit 1

CMD ["nginx", "-g", "daemon off;"]

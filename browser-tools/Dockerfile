# Serves the Peak Automations browser tools as static files.
#   docker build -t peak-browser-tools browser-tools
#   docker run --rm -p 8080:80 peak-browser-tools      ->  http://localhost:8080
FROM nginx:1.27-alpine
COPY *.html SHA256SUMS.txt /usr/share/nginx/html/
COPY js /usr/share/nginx/html/js
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD wget -qO- http://127.0.0.1/ >/dev/null || exit 1

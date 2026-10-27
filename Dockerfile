# syntax=docker/dockerfile:1

# ---- build stage: compile/download the SQLite native module -------------------
FROM node:20-alpine AS build
WORKDIR /app
# Toolchain is only a fallback in case no prebuilt better-sqlite3 binary matches.
RUN apk add --no-cache python3 make g++
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# ---- runtime stage: small final image ----------------------------------------
FROM node:20-alpine
LABEL org.opencontainers.image.title="PeakHook" \
      org.opencontainers.image.description="Self-hosted webhook vault, inspector and replay gateway for n8n, Make and Zapier" \
      org.opencontainers.image.url="https://peakautomations.online/tools/" \
      org.opencontainers.image.licenses="MIT"

ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/app/data
WORKDIR /app

RUN apk add --no-cache tini su-exec
COPY --from=build /app/node_modules ./node_modules
COPY package.json server.js ./
COPY public ./public
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh \
 && mkdir -p /app/data && chown -R node:node /app/data

VOLUME ["/app/data"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# The entrypoint fixes ownership of the mounted ./data folder, then drops root.
ENTRYPOINT ["/sbin/tini", "--", "docker-entrypoint.sh"]
CMD ["node", "server.js"]

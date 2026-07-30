# NEOP — control plane + worker + console in one hardened container.
#
# Build:  docker compose build        (or: docker build -t neop .)
# Run:    docker compose up -d        (journal persists in the neop-data volume)
#
# Posture (plan §5): non-root user, no extra capabilities (compose drops ALL),
# git + sh present because the worker's evidence pipeline is real subprocesses
# (worktrees, diffs, successChecks). Secrets arrive as env at runtime — never
# baked into the image (.dockerignore excludes every .env).

# ---------- build stage: compile worker + console ----------
FROM node:24-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY bin ./bin
COPY bench ./bench
COPY tests ./tests
RUN npm run build

COPY web/package.json web/package-lock.json ./web/
RUN cd web && npm ci
COPY web ./web
# same-origin console: the plane serves it, so the API base is /
RUN cd web && VITE_NEOP_API_BASE=/ npm run build

# ---------- runtime stage ----------
FROM node:24-slim
# git: worktrees + diffs (the evidence pipeline). ca-certificates: provider TLS.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY --from=build /app/web/dist ./web/dist
COPY tasks ./tasks
COPY registry ./registry

# non-root; /data owned by the runtime user so the named volume inherits it
RUN useradd --create-home neop && mkdir /data && chown neop:neop /data
USER neop

ENV NODE_ENV=production \
    PORT=8000 \
    NEOP_DATA_DIR=/data \
    NEOP_WEB_DIST=/app/web/dist \
    NEOP_TASKS_DIR=/app/tasks

EXPOSE 8000
VOLUME /data
HEALTHCHECK --interval=30s --timeout=3s --start-period=15s \
  CMD curl -fsS http://localhost:8000/health || exit 1

CMD ["node", "dist/bin/serve.js"]

# syntax=docker/dockerfile:1
#
# Multi-stage build for Railway. The runtime image carries production
# dependencies only — no compiler, no dev tooling.

# ---- build ----------------------------------------------------------
FROM node:20-alpine AS build
WORKDIR /app

# Copy manifests first so the dependency layer caches across code changes.
COPY package*.json ./
RUN npm ci

COPY tsconfig.json nest-cli.json ./
COPY src ./src
COPY db ./db

RUN npm run build

# The migration runner reads SQL from dist/db, and nest-cli's asset copy only
# runs when the glob matches — copy explicitly so a build never ships without
# its migrations.
RUN mkdir -p dist/db && cp db/*.sql dist/db/

# ---- runtime --------------------------------------------------------
FROM node:20-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production

# dumb-init reaps zombies and forwards SIGTERM, so Railway's redeploy signal
# actually reaches Node instead of being swallowed by PID 1.
RUN apk add --no-cache dumb-init && \
    addgroup -S kwema && adduser -S kwema -G kwema

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY --from=build /app/db ./db

USER kwema

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||3000)+'/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

ENTRYPOINT ["dumb-init", "--"]

# Migrations run before the server binds. If a migration fails the container
# exits non-zero and Railway keeps the previous deployment serving traffic.
CMD ["sh", "-c", "node dist/db/migrate.js && node dist/main.js"]

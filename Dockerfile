# One image for every role: setup (migrations and seed), api, worker and web.
# Build arg NPM_REGISTRY switches the npm registry (e.g. https://registry.npmmirror.com in mainland China).
FROM node:26.12.1-trixie-slim@sha256:36793bcbb160a6a16cede1e62b93f84e26b78a972a8a4c0b879c1c12f22761ec AS base
WORKDIR /app
# decision: use PGDG's PostgreSQL 18 client for backups; not trixie's default client because
# pg_dump 17 cannot dump the PostgreSQL 18 server defined in compose.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates=20250419+deb13u1 curl \
 && install -d /usr/share/postgresql-common/pgdg \
 && curl --fail --silent --show-error -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc https://www.postgresql.org/media/keys/ACCC4CF8.asc \
 && printf '%s\n' 'Types: deb' 'URIs: https://apt.postgresql.org/pub/repos/apt' 'Suites: trixie-pgdg' 'Components: main' 'Signed-By: /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc' > /etc/apt/sources.list.d/pgdg.sources \
 && apt-get update \
 && apt-get install -y --no-install-recommends postgresql-client-18 \
 && apt-get purge -y --auto-remove curl \
 && rm -rf /var/lib/apt/lists/*

FROM base AS build
ARG NPM_REGISTRY=
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY packages/backend/package.json packages/backend/
COPY packages/contracts/package.json packages/contracts/
COPY industry/package.json industry/
RUN npm ci --no-audit --no-fund ${NPM_REGISTRY:+--registry=$NPM_REGISTRY}
COPY . .
RUN npm run build -w @aihot/web && npm prune --omit=dev --no-audit --no-fund

FROM base
ENV NODE_ENV=production
COPY --from=build --chown=node:node /app /app
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.ts"]

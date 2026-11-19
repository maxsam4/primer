# Production image for Primer: the API (Hono) serves the built web app from the
# same process (SERVE_STATIC=1), so a release is one image rather than an API
# image plus a separate static host that could drift out of version with it.
#
# Migrations run before the server starts (see CMD) so a new version never
# serves traffic against a schema it does not match, and a failed migration
# fails the container instead of leaving a half-upgraded service running.
#
# The file lives in apps/api/ because the shared docker-test action looks for
# `<package dir>/Dockerfile`, but the build context is the repository root: the
# build needs the root lockfile, pnpm-workspace.yaml and every workspace
# package, so build with `docker build -f apps/api/Dockerfile .`.
#
# Each architecture is built on a native runner, so there is no cross-build
# stage and native addons in the dependency tree are safe.
#
# `--ignore-scripts` on install follows the team Dockerfile standard. It is
# safe here because pnpm-workspace.yaml allowlists build scripts for esbuild
# only, and esbuild's platform binary arrives as an optional dependency rather
# than from its postinstall. The image build fails if that stops being true.

# node:24-bookworm-slim, pinned by digest (multi-arch index). Bump deliberately.
ARG NODE_IMAGE=node:24-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205

FROM ${NODE_IMAGE} AS build
WORKDIR /src
# The pnpm version comes from the root package.json "packageManager" field, so
# there is a single place to bump it.
RUN corepack enable
COPY . .
# --frozen-lockfile installs exactly the lockfile and never re-resolves past the
# minimumReleaseAge gate.
RUN pnpm install --frozen-lockfile --ignore-scripts
RUN pnpm --filter @polygonlabs/primer-api-types --filter @primer/web --filter @primer/api run build
# Self-contained API directory with production dependencies only; sources and
# tests are removed so the runtime image carries compiled output alone.
RUN pnpm --filter @primer/api deploy --prod --legacy /out/api \
 && rm -rf /out/api/src /out/api/scripts /out/api/container-tests /out/api/*.test.* /out/api/vitest*.ts \
 && mkdir -p /out/web && cp -r apps/web/dist /out/web/dist

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    SERVE_STATIC=1 \
    STATIC_ROOT=/app/web/dist \
    PORT=3000
WORKDIR /app
COPY --from=build --chown=root:root /out/api /app/api
COPY --from=build --chown=root:root /out/web /app/web
# Code is root-owned and read-only to the app user, so a compromised process
# cannot rewrite it. The filesystem storage backend must therefore be pointed
# outside /app (STORAGE_ROOT). /data/blobs is created here, owned by node: a
# fresh named volume mounted there copies this ownership on first use, so the
# filesystem backend can write to it without running as root.
RUN mkdir -p /data/blobs && chown node:node /data/blobs
USER node
EXPOSE 3000
WORKDIR /app/api
CMD ["sh", "-c", "node dist/db/migrate.js && exec node dist/index.js"]

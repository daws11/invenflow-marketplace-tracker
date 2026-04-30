# syntax=docker/dockerfile:1.7

# -----------------------------------------------------------------------------
# Stage 1: install deps for the whole pnpm workspace
# -----------------------------------------------------------------------------
FROM node:20-slim AS deps
WORKDIR /repo
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

# Bring in the workspace manifests so pnpm can resolve the dep graph.
COPY package.json pnpm-workspace.yaml tsconfig.json ./
COPY apps/web/package.json ./apps/web/
COPY apps/worker/package.json ./apps/worker/
COPY packages/shared/package.json ./packages/shared/

# `--frozen-lockfile=false` because the lockfile is generated in B2; for now we
# want install to succeed even without one. Once `pnpm-lock.yaml` is committed,
# this can be tightened to `--frozen-lockfile`.
RUN pnpm install --frozen-lockfile=false

# -----------------------------------------------------------------------------
# Stage 2: build the Next.js app in standalone mode
# -----------------------------------------------------------------------------
FROM node:20-slim AS builder
WORKDIR /repo
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

COPY --from=deps /repo/node_modules ./node_modules
COPY --from=deps /repo/apps/web/node_modules ./apps/web/node_modules
COPY --from=deps /repo/apps/worker/node_modules ./apps/worker/node_modules
COPY --from=deps /repo/packages/shared/node_modules ./packages/shared/node_modules
COPY . .

ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm --filter @invenflow-tracker/web build

# -----------------------------------------------------------------------------
# Stage 3: minimal runtime — only the standalone bundle + static assets
# -----------------------------------------------------------------------------
FROM node:20-slim AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

RUN apt-get update \
    && apt-get install -y --no-install-recommends curl openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system --gid 1001 nodejs \
    && useradd --system --uid 1001 --gid nodejs nextjs

# Prisma CLI shipped globally so the entrypoint can run `migrate deploy`
# against the production DB on container start. Pinned to the same minor as
# @prisma/client in apps/web/package.json so engine versions stay in sync.
RUN npm install -g prisma@5.22.0

# `next build` with `output: 'standalone'` puts a self-contained server bundle
# at .next/standalone/. The static assets live separately and must be copied
# alongside it.
COPY --from=builder --chown=nextjs:nodejs /repo/apps/web/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder --chown=nextjs:nodejs /repo/apps/web/public ./apps/web/public

# Schema + migrations live alongside the bundle so the entrypoint can apply
# them via `prisma migrate deploy`. The standalone build doesn't pull these
# in by default since no app code imports them at runtime.
COPY --from=builder --chown=nextjs:nodejs /repo/apps/web/prisma ./apps/web/prisma

# Wrapper entrypoint: runs migrations, then execs the Next.js server.
COPY --chown=nextjs:nodejs apps/web/start-prod.sh /app/start-prod.sh
RUN chmod +x /app/start-prod.sh

USER nextjs
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD curl -fsS http://localhost:3000/api/health || exit 1

CMD ["/app/start-prod.sh"]

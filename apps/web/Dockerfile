# syntax=docker/dockerfile:1.7

# -----------------------------------------------------------------------------
# Stage 1: install deps for the whole pnpm workspace
# -----------------------------------------------------------------------------
FROM node:20-slim AS deps
WORKDIR /repo
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

# Bring in the workspace manifests + lockfile so --frozen-lockfile can verify
# all 5 workspace projects (root, web, worker, extension, shared).
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.json ./
COPY apps/web/package.json ./apps/web/
COPY apps/worker/package.json ./apps/worker/
COPY apps/extension/package.json ./apps/extension/
COPY packages/shared/package.json ./packages/shared/

# Use the committed pnpm-lock.yaml. `--frozen-lockfile` pins the exact resolved
# versions so a clean (--no-cache) build can't drift to newer deps that break
# the build.
RUN pnpm install --frozen-lockfile

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

# Generate the Prisma client BEFORE `next build`. Next.js type-checks
# during the production build, so `@prisma/client` must have the
# schema-specific Account / Run / OrderLineItem etc. types — those only
# appear after `prisma generate` rewrites node_modules/.prisma/client.
RUN pnpm --filter @invenflow-tracker/web exec prisma generate

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

# bcryptjs is required by prisma/seed.js (admin password hashing) and by
# NextAuth's credentials provider. The Next.js standalone trace doesn't
# reliably pick it up across pnpm symlinks, so copy the resolved package
# directly into the standalone bundle's node_modules. This is a tiny
# pure-JS module (~50KB) so the image cost is negligible.
# pnpm keeps the actual files under .pnpm/ — copy from there so we
# don't try to follow a symlink.
COPY --from=builder --chown=nextjs:nodejs \
    /repo/node_modules/.pnpm/bcryptjs@2.4.3/node_modules/bcryptjs \
    ./node_modules/bcryptjs

# Wrapper entrypoint: runs migrations, then execs the Next.js server.
COPY --chown=nextjs:nodejs apps/web/start-prod.sh /app/start-prod.sh
RUN chmod +x /app/start-prod.sh

USER nextjs
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD curl -fsS http://localhost:3000/api/health || exit 1

CMD ["/app/start-prod.sh"]

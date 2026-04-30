#!/bin/sh
# Production entrypoint for the Next.js web container.
#
# Runs `prisma migrate deploy` against the configured DATABASE_URL before
# starting the server. This keeps Coolify deploys self-applying — schema
# changes land automatically when the new image rolls out, and a failed
# migration crashes the container so Coolify retries / surfaces the error
# rather than serving a stale schema.
#
# Idempotent: prisma migrate deploy is safe to re-run after every restart.
set -e

echo "[start-prod] applying prisma migrations..."
cd /app/apps/web
prisma migrate deploy --schema=./prisma/schema.prisma

# Seed runs after migrate so first boot creates the initial admin + setting
# rows from INITIAL_* env vars. Idempotent — re-runs skip when records
# already exist. seed.js is plain CommonJS (no tsx/ts-node needed) so it
# works with just the standalone bundle's runtime deps.
echo "[start-prod] running prisma seed..."
node /app/apps/web/prisma/seed.js

echo "[start-prod] migrations + seed complete; starting next.js server"
cd /app
exec node apps/web/server.js

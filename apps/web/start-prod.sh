#!/bin/sh
# Production entrypoint for the Next.js web container.
#
# Runs `prisma migrate deploy` against the configured DATABASE_URL before
# starting the server. Keeps Coolify deploys self-applying.
#
# On any failure we drop into `tail -f /dev/null` rather than exiting so
# the container stays "running" long enough for Coolify's logs panel to
# expose the error. (Default behaviour is `set -e`-based exit, which puts
# the container into a fast restart loop; Coolify only streams logs when
# the container is in `running` state, so a fast restarter is invisible.)

set -x

cd /app/apps/web

echo "[start-prod] [1/3] prisma migrate deploy..."
if ! prisma migrate deploy --schema=./prisma/schema.prisma; then
  echo "[start-prod] FATAL: prisma migrate deploy failed - keeping container alive for log inspection"
  exec tail -f /dev/null
fi

echo "[start-prod] [2/3] prisma seed..."
if ! node /app/apps/web/prisma/seed.js; then
  echo "[start-prod] FATAL: seed failed - keeping container alive for log inspection"
  exec tail -f /dev/null
fi

echo "[start-prod] [3/3] starting next.js server"
cd /app
node apps/web/server.js
SERVER_EXIT=$?
echo "[start-prod] FATAL: next.js server exited with code $SERVER_EXIT - keeping container alive for log inspection"
exec tail -f /dev/null

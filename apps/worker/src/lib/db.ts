// Prisma client singleton (worker-side mirror of apps/web/src/lib/db.ts).
//
// Sharing decision (C1): Option B — duplicated in worker. Option A
// (move to packages/shared) was abandoned because shared isn't currently
// listed as a dep of either apps/worker or apps/web, and the C1 brief
// forbids adding new packages or running pnpm install. The web's copy is
// preserved unchanged so its existing import paths keep working; this file
// mirrors the same singleton pattern.
//
// Unlike the web, the worker is not subject to Next.js hot-reload, but we
// still cache on `globalThis` so that `tsx watch` re-runs in dev don't leak
// Postgres connections.

import { PrismaClient } from '@prisma/client';

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log:
      process.env.NODE_ENV === 'development'
        ? ['query', 'error', 'warn']
        : ['error'],
  });

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}

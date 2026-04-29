// Prisma client singleton.
//
// In dev, Next.js hot-reload re-evaluates this module on every change; without
// caching we leak Postgres connections (eventually `Sorry, too many clients
// already`). Cache the client on `globalThis` so each reload reuses the same
// instance. In prod we instantiate exactly once.

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

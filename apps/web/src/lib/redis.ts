// Process-wide ioredis client for the web app.
//
// Used by the browser-session API routes (start / status / save / cancel)
// to coordinate with the worker over Redis. The Redis hash shapes and key
// names mirror what `apps/worker/src/queue/session-state.ts` writes; both
// modules import from a shared place — `session-state.ts` (web mirror) —
// so any rename happens in one spot.
//
// Why a singleton: Next.js dev hot-reload re-evaluates this module on every
// change. Without caching we leak Redis sockets (and trigger reconnect log
// spam). The pattern mirrors `apps/web/src/lib/db.ts`'s Prisma singleton.
//
// Why lazy: Next.js evaluates route modules at build time. If we eagerly
// new up an ioredis client at import, the build process opens a socket
// against $REDIS_URL — which during `next build` typically isn't reachable.
// We expose a Proxy that constructs the real client on first method call
// instead. This keeps `next build` quiet while still giving runtime callers
// a plain `redis.get(...)` API.

import IORedis, { type Redis } from 'ioredis';

const globalForRedis = globalThis as unknown as {
  redis: Redis | undefined;
};

function makeClient(): Redis {
  const url = process.env.REDIS_URL;
  if (!url) {
    throw new Error(
      'REDIS_URL is not set; the browser-session API requires Redis.',
    );
  }
  const client = new IORedis(url, {
    // We're not running BullMQ workers in the web process, but we still set
    // `maxRetriesPerRequest: null` so commands queued during a brief reconnect
    // don't fail with "Stream isn't writeable".
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    // Lazy connect so the first command triggers the dial. Avoids
    // ECONNREFUSED spam at build time.
    lazyConnect: true,
  });
  return client;
}

function getClient(): Redis {
  if (globalForRedis.redis) return globalForRedis.redis;
  const client = makeClient();
  if (process.env.NODE_ENV !== 'production') {
    globalForRedis.redis = client;
  } else {
    globalForRedis.redis = client;
  }
  return client;
}

/** Lazy proxy: any property access goes through `getClient()` so the
 *  underlying ioredis instance is constructed at first use, not at import. */
export const redis: Redis = new Proxy({} as Redis, {
  get(_t, prop: string | symbol, receiver) {
    const client = getClient() as unknown as Record<string | symbol, unknown>;
    const value = client[prop];
    return typeof value === 'function'
      ? (value as (...a: unknown[]) => unknown).bind(client)
      : value;
  },
});

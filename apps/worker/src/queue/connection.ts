// Single ioredis connection used by every BullMQ Queue + Worker in this
// process. BullMQ requires `maxRetriesPerRequest: null` and
// `enableReadyCheck: false` on the underlying ioredis client, otherwise
// blocking commands (BRPOPLPUSH etc.) error out spuriously.
//
// We expose a singleton; opening a fresh ioredis per Queue/Worker burns
// connections and confuses pub/sub.

import IORedis, { type Redis } from 'ioredis';

import { env } from '../lib/env.js';
import { childLogger } from '../lib/logger.js';

const log = childLogger('redis');

let connection: Redis | null = null;

/**
 * Returns the process-wide ioredis client, creating it on first call.
 * The client is configured for BullMQ; do not pass it to other code paths
 * that expect default ioredis semantics (e.g. that retry per-request).
 */
export function getRedisConnection(): Redis {
  if (connection) return connection;

  connection = new IORedis(env.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    // Lazy connect so we can run a controlled PING from index.ts and report
    // a clean error instead of spamming `ioredis` reconnect noise on boot.
    lazyConnect: true,
  });

  connection.on('error', (err) => {
    log.error({ err: err.message }, 'redis client error');
  });
  connection.on('reconnecting', (delay: number) => {
    log.warn({ delay }, 'redis reconnecting');
  });
  connection.on('end', () => {
    log.warn('redis connection ended');
  });

  return connection;
}

/** Test helper: replace the cached client (e.g. for unit tests). */
export function __setRedisConnection(client: Redis | null): void {
  connection = client;
}

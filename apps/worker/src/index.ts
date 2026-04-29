// Worker process entry point (C1).
//
// Boot sequence:
//   1. Validate env (fail fast on misconfiguration).
//   2. Initialize logger; print startup banner.
//   3. Connect to Redis with retries; PING to verify.
//   4. Connect to Postgres via Prisma with retries; SELECT 1 to verify.
//   5. Start BullMQ workers (concurrency = 1 each).
//   6. Wait for SIGINT/SIGTERM; gracefully drain in-flight jobs.
//
// On unhandled exception/rejection or a second termination signal, we
// log and force-exit(1) instead of hanging. PID 1 inside the container
// must be this Node process so Docker can deliver signals; start.sh
// `exec`s it.

import { performance } from 'node:perf_hooks';

import type { Worker } from 'bullmq';

import { prisma } from './lib/db.js';
import { loadEnv, type WorkerEnv } from './lib/env.js';
import { logger } from './lib/logger.js';
import { getRedisConnection } from './queue/connection.js';
import { getAllQueues } from './queue/queues.js';
import { startWorkers } from './queue/workers.js';
import { syncCronRegistrations } from './scheduler/cron.js';

const SHUTDOWN_TIMEOUT_MS = 30_000;
const RETRY_ATTEMPTS = 3;
const CONNECT_PROBE_TIMEOUT_MS = 5_000;

/**
 * Periodic cron-resync interval. Per cron.ts header — accept up to this
 * much lag between an Account.cron* update in the web UI and the new
 * schedule taking effect on the BullMQ side.
 */
const CRON_RESYNC_INTERVAL_MS = 5 * 60 * 1000;

let workers: Worker[] = [];
let cronTimer: NodeJS.Timeout | null = null;
let shuttingDown = false;

async function main(): Promise<void> {
  const t0 = performance.now();

  // 1. Env validation — throws with a combined message if anything is wrong.
  let env: WorkerEnv;
  try {
    env = loadEnv();
  } catch (err) {
    // Log via console because logger.ts may itself depend on env vars
    // (LOG_LEVEL); fall back to stderr for the boot-stage failure.
    process.stderr.write(`[worker] startup failed: ${(err as Error).message}\n`);
    process.exit(1);
  }

  // 2. Banner.
  logger.info(
    {
      nodeVersion: process.version,
      nodeEnv: env.NODE_ENV,
      display: env.DISPLAY,
      pid: process.pid,
    },
    'worker starting',
  );

  // 3. Redis. ioredis with `maxRetriesPerRequest: null` retries forever
  // in the background; we cap the boot probe with our own timeout.
  await connectWithRetry('redis', async () => {
    const redis = getRedisConnection();
    if (redis.status === 'wait' || redis.status === 'end') {
      await withTimeout(redis.connect(), CONNECT_PROBE_TIMEOUT_MS, 'redis connect');
    }
    const pong = await withTimeout(
      redis.ping(),
      CONNECT_PROBE_TIMEOUT_MS,
      'redis ping',
    );
    if (pong !== 'PONG') {
      throw new Error(`unexpected PING response: ${String(pong)}`);
    }
  });

  // 4. Postgres.
  await connectWithRetry('postgres', async () => {
    await withTimeout(
      prisma.$queryRaw`SELECT 1` as unknown as Promise<unknown>,
      CONNECT_PROBE_TIMEOUT_MS,
      'postgres SELECT 1',
    );
  });

  // 5. Workers.
  workers = startWorkers();
  logger.info(
    { workerCount: workers.length, queues: getAllQueues().map((q) => q.name) },
    'workers started',
  );

  // 5b. Initial cron registration sync. Best-effort — a transient failure
  //     here doesn't abort startup; the periodic resync below will catch
  //     up on the next tick.
  try {
    await syncCronRegistrations();
  } catch (err) {
    logger.warn(
      { err: (err as Error).message },
      'initial cron sync failed; relying on periodic resync',
    );
  }

  // 5c. Periodic resync — see cron.ts header for the trade-off rationale.
  cronTimer = setInterval(() => {
    void syncCronRegistrations().catch((err: unknown) => {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'cron resync failed (will retry next interval)',
      );
    });
  }, CRON_RESYNC_INTERVAL_MS);
  // Don't keep the loop alive solely for the resync timer.
  cronTimer.unref();

  // 6. Signals.
  process.on('SIGINT', () => void handleSignal('SIGINT'));
  process.on('SIGTERM', () => void handleSignal('SIGTERM'));

  process.on('uncaughtException', (err) => {
    logger.fatal({ err: err.message, stack: err.stack }, 'uncaughtException');
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    logger.fatal({ reason }, 'unhandledRejection');
    process.exit(1);
  });

  const elapsed = Math.round(performance.now() - t0);
  logger.info({ bootMs: elapsed }, 'worker ready');
}

/**
 * Runs `op` up to RETRY_ATTEMPTS times with exponential backoff. On final
 * failure, logs and exits(1).
 */
async function connectWithRetry(
  label: string,
  op: () => Promise<void>,
): Promise<void> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
    try {
      await op();
      logger.info({ attempt }, `${label} reachable`);
      return;
    } catch (err) {
      lastErr = err;
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(
        { attempt, total: RETRY_ATTEMPTS, err: message },
        `${label} unreachable, retrying`,
      );
      if (attempt < RETRY_ATTEMPTS) {
        await sleep(500 * 2 ** (attempt - 1));
      }
    }
  }

  const message =
    lastErr instanceof Error ? lastErr.message : String(lastErr);
  logger.fatal(
    { err: message },
    `${label} unreachable after ${RETRY_ATTEMPTS} attempts; exiting`,
  );
  process.exit(1);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Resolves as `op` would, or rejects with a timeout error after `ms`.
 * The underlying op is left running; callers must tolerate that (we do —
 * the only callers are connectivity probes whose connections we tear
 * down via `process.exit` on failure).
 */
function withTimeout<T>(
  op: PromiseLike<T>,
  ms: number,
  label: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);
    Promise.resolve(op).then(
      (val) => {
        clearTimeout(timer);
        resolve(val);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

async function handleSignal(signal: string): Promise<void> {
  if (shuttingDown) {
    logger.warn({ signal }, 'second signal received; forcing exit');
    process.exit(1);
  }
  shuttingDown = true;
  logger.info({ signal }, 'shutdown initiated');

  const shutdownTimer = setTimeout(() => {
    logger.error(
      { timeoutMs: SHUTDOWN_TIMEOUT_MS },
      'shutdown timed out; forcing exit',
    );
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  // Don't keep the loop alive solely for this timer.
  shutdownTimer.unref();

  try {
    // Stop the cron resync timer so it doesn't fire mid-shutdown.
    if (cronTimer) {
      clearInterval(cronTimer);
      cronTimer = null;
    }

    // Stop accepting new jobs but let in-flight ones finish.
    await Promise.all(workers.map((w) => w.close(false)));
    logger.info('workers closed');

    // Close queue connections.
    await Promise.all(getAllQueues().map((q) => q.close()));
    logger.info('queues closed');

    // Disconnect Redis + Prisma.
    try {
      const redis = getRedisConnection();
      await redis.quit();
    } catch (err) {
      logger.warn(
        { err: (err as Error).message },
        'redis quit failed; ignoring',
      );
    }
    await prisma.$disconnect();
    logger.info('connections closed');

    clearTimeout(shutdownTimer);
    process.exit(0);
  } catch (err) {
    logger.fatal(
      { err: (err as Error).message, stack: (err as Error).stack },
      'shutdown error; forcing exit',
    );
    process.exit(1);
  }
}

main().catch((err) => {
  logger.fatal(
    { err: err instanceof Error ? err.message : String(err) },
    'fatal error during boot',
  );
  process.exit(1);
});

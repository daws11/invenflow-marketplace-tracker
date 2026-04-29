// Liveness/readiness check.
//
// - Database: a 5s-bounded `SELECT 1` against Postgres via Prisma.
// - Redis: a `PING` against `REDIS_URL` if it is configured; otherwise
//   reported as `skipped` (we don't want missing Redis to fail the check
//   in environments — like the test rig — that don't run a queue).
//
// Returns 200 when both checks are `ok` (or redis is `skipped`); 503 if any
// configured dependency is `fail`. The shape is stable per PRD §7.6: any
// caller (InvenFlow's "Test Connection" button, uptime probes, etc.) can
// rely on `status` and `checks.*`.

import { NextResponse } from 'next/server';

import { prisma } from '@/lib/db';

export const dynamic = 'force-dynamic';

const DB_TIMEOUT_MS = 5000;
const REDIS_TIMEOUT_MS = 5000;

type CheckResult = 'ok' | 'fail' | 'skipped';

interface HealthBody {
  status: 'ok' | 'degraded';
  checks: {
    database: CheckResult;
    redis: CheckResult;
  };
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms,
    );
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (err) => {
        clearTimeout(t);
        reject(err);
      },
    );
  });
}

async function checkDatabase(): Promise<CheckResult> {
  try {
    await withTimeout(prisma.$queryRaw`SELECT 1`, DB_TIMEOUT_MS, 'database');
    return 'ok';
  } catch {
    return 'fail';
  }
}

async function checkRedis(): Promise<CheckResult> {
  const url = process.env.REDIS_URL;
  if (!url) return 'skipped';

  // Lazy-load ioredis so environments without it (or without a Redis
  // configured) don't pay the import cost.
  let Redis: typeof import('ioredis').default;
  try {
    Redis = (await import('ioredis')).default;
  } catch {
    // ioredis not installed — treat as skipped rather than fail.
    return 'skipped';
  }

  const client = new Redis(url, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    enableReadyCheck: true,
    connectTimeout: REDIS_TIMEOUT_MS,
  });

  try {
    await withTimeout(client.connect(), REDIS_TIMEOUT_MS, 'redis-connect');
    const pong = await withTimeout(
      client.ping(),
      REDIS_TIMEOUT_MS,
      'redis-ping',
    );
    return pong === 'PONG' ? 'ok' : 'fail';
  } catch {
    return 'fail';
  } finally {
    try {
      client.disconnect();
    } catch {
      // ignore
    }
  }
}

export async function GET() {
  const [database, redis] = await Promise.all([
    checkDatabase(),
    checkRedis(),
  ]);

  const anyFail = database === 'fail' || redis === 'fail';
  const body: HealthBody = {
    status: anyFail ? 'degraded' : 'ok',
    checks: { database, redis },
  };

  return NextResponse.json(body, { status: anyFail ? 503 : 200 });
}

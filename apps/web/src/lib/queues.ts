// BullMQ queue producers (web-side).
//
// The worker process owns the BullMQ Worker side; the web process only ever
// produces. We mirror the queue *names* the worker uses (kept in
// apps/worker/src/queue/queues.ts) and instantiate fresh `Queue` objects
// here that share the web's existing ioredis singleton.
//
// Why a separate file (vs. importing the worker's queues.ts):
//   - apps/web is a Next.js project compiled by next build; its tsconfig
//     can't reach `apps/worker/src/...` because the workspace isn't a
//     references graph (no `composite: true`). Duplicating the names is the
//     same Option B sharing decision the rest of the codebase made for
//     `db.ts`, `settings.ts`, and `fonnte.ts`.
//
// Why globalThis caching: Next.js dev hot-reload re-evaluates this module
// on every change. Without caching we leak BullMQ pub/sub subscribers on
// each rebuild. The browser-session route already uses this pattern; we
// generalize it here.

import { Queue } from 'bullmq';

import { redis } from './redis';

// -----------------------------------------------------------------------------
// Names (must match apps/worker/src/queue/queues.ts)
// -----------------------------------------------------------------------------

export const QUEUE_BROWSER_SESSION = 'browser-session' as const;
export const QUEUE_SCRAPE_PAID = 'scrape-paid' as const;
export const QUEUE_SCRAPE_SHIPPED = 'scrape-shipped' as const;
export const QUEUE_DAILY_DIGEST = 'daily-digest' as const;

// -----------------------------------------------------------------------------
// Job-data shapes (must match the worker's interfaces)
// -----------------------------------------------------------------------------

export type TriggeredBy = 'manual' | 'scheduled' | 'cron';

export interface BaseJobData {
  accountId: string;
  triggeredBy: TriggeredBy;
}

export interface ScrapePaidJobData extends BaseJobData {
  urlOverride?: string;
  runId?: string;
}

export interface ScrapeShippedJobData extends BaseJobData {
  urlOverride?: string;
  runId?: string;
}

// -----------------------------------------------------------------------------
// Lazy singletons cached on globalThis so Next.js hot-reload doesn't leak.
// -----------------------------------------------------------------------------

const globalForQueues = globalThis as unknown as {
  scrapePaidQueue: Queue<ScrapePaidJobData> | undefined;
  scrapeShippedQueue: Queue<ScrapeShippedJobData> | undefined;
};

export function getScrapePaidQueue(): Queue<ScrapePaidJobData> {
  if (globalForQueues.scrapePaidQueue) return globalForQueues.scrapePaidQueue;
  const q = new Queue<ScrapePaidJobData>(QUEUE_SCRAPE_PAID, {
    connection: redis,
  });
  globalForQueues.scrapePaidQueue = q;
  return q;
}

export function getScrapeShippedQueue(): Queue<ScrapeShippedJobData> {
  if (globalForQueues.scrapeShippedQueue)
    return globalForQueues.scrapeShippedQueue;
  const q = new Queue<ScrapeShippedJobData>(QUEUE_SCRAPE_SHIPPED, {
    connection: redis,
  });
  globalForQueues.scrapeShippedQueue = q;
  return q;
}

// BullMQ Worker wiring.
//
// One Worker per queue, all sharing the same ioredis connection and all
// pinned to concurrency = 1 PER QUEUE. The PRD calls for concurrency = 1
// "globally" (§5.7); we enforce that the same way the InvenFlow sidecar
// does — by setting concurrency = 1 on each worker AND running them in a
// single Node process. If we ever scale this horizontally we'll need a
// distributed lock (Redis SETNX on a `tracker:run:lock` key); not in C1.
//
// Each Worker logs `Queue X: ready` once Redis confirms the consumer is
// listening. The `index.ts` startup sequence waits on those events to
// produce a clean banner before declaring the worker live.

import { Worker, type Job } from 'bullmq';

import { childLogger } from '../lib/logger.js';
import { getRedisConnection } from './connection.js';
import { processBrowserSessionJob } from './processors/browser-session.js';
import { processDailyDigestJob } from './processors/daily-digest.js';
import { processScrapePaidJob } from './processors/scrape-paid.js';
import { processScrapeShippedJob } from './processors/scrape-shipped.js';
import {
  QUEUE_BROWSER_SESSION,
  QUEUE_DAILY_DIGEST,
  QUEUE_SCRAPE_PAID,
  QUEUE_SCRAPE_SHIPPED,
  type BrowserSessionJobData,
  type DailyDigestJobData,
  type JobResult,
  type ScrapePaidJobData,
  type ScrapeShippedJobData,
} from './queues.js';

/** Builds a Worker with shared defaults: concurrency=1, single connection. */
function makeWorker<TData, TResult>(
  name: string,
  processor: (job: Job<TData, TResult>) => Promise<TResult>,
): Worker<TData, TResult> {
  const log = childLogger(`worker:${name}`);
  const worker = new Worker<TData, TResult>(name, processor, {
    connection: getRedisConnection(),
    concurrency: 1,
  });

  worker.on('ready', () => {
    log.info(`Queue ${name}: ready`);
  });
  worker.on('completed', (job, result) => {
    log.info(
      { jobId: job.id, accountId: (job.data as BaseLike).accountId, result },
      `job ${job.id} completed`,
    );
  });
  worker.on('failed', (job, err) => {
    log.error(
      {
        jobId: job?.id,
        accountId: (job?.data as BaseLike | undefined)?.accountId,
        err: err.message,
        stack: err.stack,
      },
      `job ${job?.id} failed`,
    );
  });
  worker.on('error', (err) => {
    log.error({ err: err.message }, `worker error`);
  });

  return worker;
}

/** Loose shape used only for log enrichment; every job carries accountId. */
interface BaseLike {
  accountId?: string;
}

/**
 * Creates and returns all three Workers. Caller is responsible for
 * holding the references and calling `.close()` on each at shutdown
 * (see `index.ts`'s graceful-shutdown handler).
 */
export function startWorkers(): Worker[] {
  const browserSessionWorker = makeWorker<BrowserSessionJobData, JobResult>(
    QUEUE_BROWSER_SESSION,
    processBrowserSessionJob,
  );

  const scrapePaidWorker = makeWorker<ScrapePaidJobData, JobResult>(
    QUEUE_SCRAPE_PAID,
    processScrapePaidJob,
  );

  const scrapeShippedWorker = makeWorker<ScrapeShippedJobData, JobResult>(
    QUEUE_SCRAPE_SHIPPED,
    processScrapeShippedJob,
  );

  const dailyDigestWorker = makeWorker<DailyDigestJobData, JobResult>(
    QUEUE_DAILY_DIGEST,
    processDailyDigestJob,
  );

  return [
    browserSessionWorker,
    scrapePaidWorker,
    scrapeShippedWorker,
    dailyDigestWorker,
  ];
}

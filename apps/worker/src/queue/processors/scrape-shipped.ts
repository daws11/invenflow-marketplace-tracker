// C1 STUB: scrape-shipped (dikirim pass) processor.
//
// Real implementation lands in C3. C1 only wires the queue / worker.
//
// C2b adds the concurrency guard (PRD §7.3.3): if an interactive browser
// session is currently active for this account, defer the scrape so we
// don't fight the operator over the shared Xvfb display. The work is
// re-queued with a 60s delay so the queue doesn't spin.

import type { Job } from 'bullmq';

import { childLogger } from '../../lib/logger.js';
import { getRedisConnection } from '../connection.js';
import {
  QUEUE_SCRAPE_SHIPPED,
  type JobResult,
  type ScrapeShippedJobData,
} from '../queues.js';
import { activeKey } from '../session-state.js';

const log = childLogger(`queue:${QUEUE_SCRAPE_SHIPPED}`);

const DEFER_DELAY_MS = 60_000;

export async function processScrapeShippedJob(
  job: Job<ScrapeShippedJobData, JobResult>,
): Promise<JobResult> {
  const { accountId } = job.data;

  // PRD §7.3.3 — pause scrape while a browser session is active for the
  // same account.
  const redis = getRedisConnection();
  const activeSessionId = await redis.get(activeKey(accountId));
  if (activeSessionId) {
    await job.moveToDelayed(Date.now() + DEFER_DELAY_MS);
    log.info(
      { accountId, sessionId: activeSessionId, jobId: job.id },
      'session active; deferring scrape-shipped by 60s',
    );
    return { ok: true, message: 'deferred (browser session active)' };
  }

  log.info(
    {
      jobId: job.id,
      accountId,
      triggeredBy: job.data.triggeredBy,
    },
    `[${QUEUE_SCRAPE_SHIPPED}] received job ${job.id} for account ${accountId}; full implementation in C3`,
  );

  return { ok: true, message: 'C1 stub' };
}

// C1 STUB: scrape-shipped (dikirim pass) processor.
//
// Real implementation lands in C3. C1 only wires the queue / worker.

import type { Job } from 'bullmq';

import { childLogger } from '../../lib/logger.js';
import {
  QUEUE_SCRAPE_SHIPPED,
  type JobResult,
  type ScrapeShippedJobData,
} from '../queues.js';

const log = childLogger(`queue:${QUEUE_SCRAPE_SHIPPED}`);

export async function processScrapeShippedJob(
  job: Job<ScrapeShippedJobData, JobResult>,
): Promise<JobResult> {
  log.info(
    {
      jobId: job.id,
      accountId: job.data.accountId,
      triggeredBy: job.data.triggeredBy,
    },
    `[${QUEUE_SCRAPE_SHIPPED}] received job ${job.id} for account ${job.data.accountId}; full implementation in C2/C3`,
  );

  return { ok: true, message: 'C1 stub' };
}

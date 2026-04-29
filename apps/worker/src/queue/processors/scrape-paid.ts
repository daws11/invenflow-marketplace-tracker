// C1 STUB: scrape-paid (dibayar pass) processor.
//
// Real two-pass scrape logic (PRD §7.4) lands in C3. C1 only wires the
// queue / worker; the processor logs the job and returns a stub result.

import type { Job } from 'bullmq';

import { childLogger } from '../../lib/logger.js';
import {
  QUEUE_SCRAPE_PAID,
  type JobResult,
  type ScrapePaidJobData,
} from '../queues.js';

const log = childLogger(`queue:${QUEUE_SCRAPE_PAID}`);

export async function processScrapePaidJob(
  job: Job<ScrapePaidJobData, JobResult>,
): Promise<JobResult> {
  log.info(
    {
      jobId: job.id,
      accountId: job.data.accountId,
      triggeredBy: job.data.triggeredBy,
    },
    `[${QUEUE_SCRAPE_PAID}] received job ${job.id} for account ${job.data.accountId}; full implementation in C2/C3`,
  );

  return { ok: true, message: 'C1 stub' };
}

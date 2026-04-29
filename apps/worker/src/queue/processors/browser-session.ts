// C1 STUB: browser-session processor.
//
// Real implementation (interactive login flow with x11vnc + Stagehand)
// lands in C2. For now we just log the job and return a stub result so
// the workers wire up cleanly and the operator can confirm the queue is
// alive end-to-end.

import type { Job } from 'bullmq';

import { childLogger } from '../../lib/logger.js';
import {
  QUEUE_BROWSER_SESSION,
  type BrowserSessionJobData,
  type JobResult,
} from '../queues.js';

const log = childLogger(`queue:${QUEUE_BROWSER_SESSION}`);

export async function processBrowserSessionJob(
  job: Job<BrowserSessionJobData, JobResult>,
): Promise<JobResult> {
  log.info(
    {
      jobId: job.id,
      accountId: job.data.accountId,
      triggeredBy: job.data.triggeredBy,
      mode: job.data.mode,
    },
    `[${QUEUE_BROWSER_SESSION}] received job ${job.id} for account ${job.data.accountId}; full implementation in C2/C3`,
  );

  return { ok: true, message: 'C1 stub' };
}

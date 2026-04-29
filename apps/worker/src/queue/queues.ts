// BullMQ queues (PRD §5.7 + §7.5).
//
// Three queues, one Redis connection. Each queue corresponds to a state
// transition in the lifecycle state machine:
//   * browser-session — interactive login / cookie refresh (PRD §7.3)
//   * scrape-paid     — first-pass scrape of the "dibayar" tab
//   * scrape-shipped  — second-pass scrape of the "dikirim" tab
//
// Concurrency is enforced GLOBALLY = 1 (PRD §5.7); see workers.ts.
// Job-data shapes are intentionally minimal in C1; later workstreams (C2,
// C3) will widen them as needed.

import { Queue } from 'bullmq';

import { getRedisConnection } from './connection.js';

// -----------------------------------------------------------------------------
// Queue names — kept as exported constants so workers + producers can't drift.
// -----------------------------------------------------------------------------

export const QUEUE_BROWSER_SESSION = 'browser-session' as const;
export const QUEUE_SCRAPE_PAID = 'scrape-paid' as const;
export const QUEUE_SCRAPE_SHIPPED = 'scrape-shipped' as const;
export const QUEUE_DAILY_DIGEST = 'daily-digest' as const;

export type QueueName =
  | typeof QUEUE_BROWSER_SESSION
  | typeof QUEUE_SCRAPE_PAID
  | typeof QUEUE_SCRAPE_SHIPPED
  | typeof QUEUE_DAILY_DIGEST;

// -----------------------------------------------------------------------------
// Job-data + result types
// -----------------------------------------------------------------------------

export type TriggeredBy = 'manual' | 'scheduled' | 'cron';

/** Shared baseline for every job. Extend per-queue as features land. */
export interface BaseJobData {
  accountId: string;
  triggeredBy: TriggeredBy;
}

/**
 * Maps the wire `TriggeredBy` to the Prisma `TriggerType` enum used on
 * `Run.triggeredBy`. C3a treats both `'cron'` and `'scheduled'` as
 * SCHEDULED; only an explicit `'manual'` (e.g. from a UI trigger endpoint)
 * lands as MANUAL. Centralized here so processors and producers agree on
 * the mapping.
 */
export function toRunTriggerType(t: TriggeredBy | undefined): 'MANUAL' | 'SCHEDULED' {
  return t === 'manual' ? 'MANUAL' : 'SCHEDULED';
}

/** Browser session job — interactive login / cookie refresh. */
export interface BrowserSessionJobData extends BaseJobData {
  /**
   * 'login' = user is going to log in via VNC; 'refresh' = headless
   * cookie-warmup. Real semantics land in C2.
   */
  mode?: 'login' | 'refresh';
}

/** Scrape "dibayar" (paid) job. */
export interface ScrapePaidJobData extends BaseJobData {
  /** Optional override URL (per-account); resolved by C3. */
  urlOverride?: string;
  /**
   * Optional pre-created Run id (C5 manual-trigger path). When present, the
   * processor uses this Run row instead of creating one — this lets the
   * web's manual-trigger endpoint return a `runId` immediately so the UI
   * can navigate to the run-detail page and poll for status.
   */
  runId?: string;
}

/** Scrape "dikirim" (shipped) job. */
export interface ScrapeShippedJobData extends BaseJobData {
  urlOverride?: string;
  /**
   * Optional pre-created Run id (C5 manual-trigger path). When present, the
   * processor uses this Run row instead of creating one.
   */
  runId?: string;
}

/**
 * Daily-digest job — composes a single WhatsApp message summarizing today's
 * shipped-pass runs. Job-data is intentionally trivial; the processor reads
 * the trailing-24h Run rows from Postgres (PRD §7.7 daily digest).
 */
export interface DailyDigestJobData {
  kind: 'daily-digest';
}

/**
 * Shared job-result envelope. Tightened in later workstreams; kept loose
 * here so C1 stubs typecheck without committing to a final shape.
 */
export interface JobResult {
  ok: boolean;
  message: string;
  /** Optional structured payload — e.g. counts, run id. */
  data?: Record<string, unknown>;
}

// -----------------------------------------------------------------------------
// Queue instances — share a single connection.
// -----------------------------------------------------------------------------

const connection = getRedisConnection();

export const browserSessionQueue = new Queue<BrowserSessionJobData, JobResult>(
  QUEUE_BROWSER_SESSION,
  { connection },
);

export const scrapePaidQueue = new Queue<ScrapePaidJobData, JobResult>(
  QUEUE_SCRAPE_PAID,
  { connection },
);

export const scrapeShippedQueue = new Queue<ScrapeShippedJobData, JobResult>(
  QUEUE_SCRAPE_SHIPPED,
  { connection },
);

export const dailyDigestQueue = new Queue<DailyDigestJobData, JobResult>(
  QUEUE_DAILY_DIGEST,
  { connection },
);

/**
 * All queues in a single iterable — used by graceful shutdown to close
 * each one without hard-coding a list at the call site.
 */
export const getAllQueues = () =>
  [browserSessionQueue, scrapePaidQueue, scrapeShippedQueue, dailyDigestQueue] as const;

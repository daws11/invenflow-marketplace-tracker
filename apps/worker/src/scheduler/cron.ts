// Cron scheduler — registers BullMQ repeatable jobs that drive the periodic
// scrape passes (PRD §5.7 + §7.4).
//
// Sync strategy (C5): periodic resync. The web UI mutates `Account` rows
// (cron toggles, schedule strings) directly via Prisma; this module reads
// the current desired state and reconciles BullMQ's repeatable-job
// registration to match. The trade-off is acceptable lag (one resync
// interval) between an Account.cron* update and the new schedule taking
// effect. The alternative — a Redis pubsub channel `cron:sync` published by
// the web on every Account write — is strictly more complex (and more
// failure modes) for a benefit (instant) that isn't required for v1.
//
// Reconciliation algorithm:
//   1. Query all accounts where cronEnabled = true.
//   2. For each, ensure a repeatable scrape-paid job exists with the right
//      cron pattern + timezone, and the same for scrape-shipped.
//   3. For each existing repeatable job that doesn't correspond to an
//      enabled account, remove it (orphan cleanup — covers
//      cronEnabled=false and account deletion).
//   4. Ensure the daily-digest repeatable job is registered exactly once.
//
// Job naming & dedup: per-account scrape jobs are named
//   `scheduled-paid-<accountId>` / `scheduled-shipped-<accountId>`
// and each carries `jobId: \`scheduled-${pass}-${accountId}\`` so BullMQ
// dedupes a redundant `add` that races during a resync window.

import type { Account } from '@prisma/client';

import { prisma } from '../lib/db.js';
import { childLogger } from '../lib/logger.js';
import { SETTING_KEYS, getSetting } from '../lib/settings.js';
import {
  dailyDigestQueue,
  scrapePaidQueue,
  scrapeShippedQueue,
  QUEUE_DAILY_DIGEST,
  QUEUE_SCRAPE_PAID,
  QUEUE_SCRAPE_SHIPPED,
} from '../queue/queues.js';

const log = childLogger('scheduler:cron');

const DEFAULT_TIMEZONE = 'Asia/Jakarta';
const DAILY_DIGEST_CRON = '0 18 * * *'; // 6 PM Asia/Jakarta — after the typical 2 PM shipped-pass run
const DAILY_DIGEST_REPEAT_KEY_SUFFIX = 'daily-digest';

// -----------------------------------------------------------------------------
// Job-name conventions
// -----------------------------------------------------------------------------

function paidJobName(accountId: string): string {
  return `scheduled-paid-${accountId}`;
}

function shippedJobName(accountId: string): string {
  return `scheduled-shipped-${accountId}`;
}

function paidJobId(accountId: string): string {
  return `scheduled-paid-${accountId}`;
}

function shippedJobId(accountId: string): string {
  return `scheduled-shipped-${accountId}`;
}

// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------

/**
 * Reconcile BullMQ repeatable jobs against the current `Account` state.
 *
 * Idempotent — safe to call on a timer. Handles add/update/remove in one
 * pass. Errors per-account are logged but do not abort the whole sync; we'd
 * rather have N-1 of N accounts correctly scheduled than zero.
 */
export async function syncCronRegistrations(): Promise<void> {
  const tz = (await getSetting<string>(SETTING_KEYS.timezone)) ?? DEFAULT_TIMEZONE;

  const accounts = await prisma.account.findMany({
    where: { cronEnabled: true },
  });

  const enabledIds = new Set(accounts.map((a) => a.id));

  // 1. Fetch existing repeatable jobs from each scrape queue. We use these
  //    to detect orphans (cronEnabled flipped to false, account deleted,
  //    schedule string changed).
  const [existingPaid, existingShipped] = await Promise.all([
    scrapePaidQueue.getRepeatableJobs(),
    scrapeShippedQueue.getRepeatableJobs(),
  ]);

  // 2. Add/update per-account.
  for (const account of accounts) {
    try {
      await ensurePerAccount(account, tz, existingPaid, existingShipped);
    } catch (err) {
      log.error(
        { accountId: account.id, err: (err as Error).message },
        'cron: failed to sync account',
      );
    }
  }

  // 3. Remove orphans — any repeatable whose accountId is not in the enabled
  //    set, or whose pattern/timezone doesn't match what we just (re-)added
  //    for an enabled account. The "doesn't match" case is already covered
  //    by ensurePerAccount removing-then-adding when the pattern drifts;
  //    here we only sweep up purely orphaned jobs.
  for (const job of existingPaid) {
    const accountId = extractAccountId(job.name, 'paid');
    if (!accountId) continue;
    if (!enabledIds.has(accountId)) {
      try {
        await scrapePaidQueue.removeRepeatableByKey(job.key);
        log.info({ key: job.key, accountId }, 'cron: removed orphan paid repeatable');
      } catch (err) {
        log.warn(
          { key: job.key, err: (err as Error).message },
          'cron: failed to remove orphan paid repeatable',
        );
      }
    }
  }
  for (const job of existingShipped) {
    const accountId = extractAccountId(job.name, 'shipped');
    if (!accountId) continue;
    if (!enabledIds.has(accountId)) {
      try {
        await scrapeShippedQueue.removeRepeatableByKey(job.key);
        log.info({ key: job.key, accountId }, 'cron: removed orphan shipped repeatable');
      } catch (err) {
        log.warn(
          { key: job.key, err: (err as Error).message },
          'cron: failed to remove orphan shipped repeatable',
        );
      }
    }
  }

  // 4. Daily digest — registered exactly once, regardless of accounts.
  try {
    await ensureDailyDigest(tz);
  } catch (err) {
    log.error(
      { err: (err as Error).message },
      'cron: failed to register daily digest',
    );
  }

  log.info(
    { accountCount: accounts.length, timezone: tz },
    'cron: sync complete',
  );
}

// -----------------------------------------------------------------------------
// Internals
// -----------------------------------------------------------------------------

interface RepeatableJobLike {
  name: string;
  key: string;
  pattern: string | null;
  tz: string | null;
}

/**
 * Idempotently ensures a repeatable for one account exists with the right
 * pattern + timezone on both queues. If the pattern or timezone has drifted
 * from the desired value, the old repeatable is removed and a new one is
 * added — BullMQ doesn't expose an in-place update API for repeatables.
 */
async function ensurePerAccount(
  account: Account,
  timezone: string,
  existingPaid: RepeatableJobLike[],
  existingShipped: RepeatableJobLike[],
): Promise<void> {
  // ----- paid -----
  await ensureOneRepeatable({
    queueAdd: (cron: string, tz: string) =>
      scrapePaidQueue.add(
        paidJobName(account.id),
        { accountId: account.id, triggeredBy: 'scheduled' },
        {
          repeat: { pattern: cron, tz },
          jobId: paidJobId(account.id),
        },
      ),
    queueRemoveByKey: (key: string) =>
      scrapePaidQueue.removeRepeatableByKey(key),
    existing: existingPaid,
    name: paidJobName(account.id),
    desiredPattern: account.cronScheduleDibayar,
    desiredTimezone: timezone,
    label: 'paid',
    accountId: account.id,
  });

  // ----- shipped -----
  await ensureOneRepeatable({
    queueAdd: (cron: string, tz: string) =>
      scrapeShippedQueue.add(
        shippedJobName(account.id),
        { accountId: account.id, triggeredBy: 'scheduled' },
        {
          repeat: { pattern: cron, tz },
          jobId: shippedJobId(account.id),
        },
      ),
    queueRemoveByKey: (key: string) =>
      scrapeShippedQueue.removeRepeatableByKey(key),
    existing: existingShipped,
    name: shippedJobName(account.id),
    desiredPattern: account.cronScheduleDikirim,
    desiredTimezone: timezone,
    label: 'shipped',
    accountId: account.id,
  });
}

interface EnsureOneArgs {
  queueAdd: (cron: string, tz: string) => Promise<unknown>;
  queueRemoveByKey: (key: string) => Promise<boolean>;
  existing: RepeatableJobLike[];
  name: string;
  desiredPattern: string;
  desiredTimezone: string;
  label: string;
  accountId: string;
}

async function ensureOneRepeatable(args: EnsureOneArgs): Promise<void> {
  const {
    queueAdd,
    queueRemoveByKey,
    existing,
    name,
    desiredPattern,
    desiredTimezone,
    label,
    accountId,
  } = args;

  const found = existing.find((j) => j.name === name);
  if (found) {
    const currentPattern = found.pattern ?? '';
    const currentTz = found.tz ?? '';
    if (currentPattern === desiredPattern && currentTz === desiredTimezone) {
      // Already in the desired shape — nothing to do.
      return;
    }
    // Drifted; remove and re-add with the desired params.
    try {
      await queueRemoveByKey(found.key);
      log.info(
        { name, key: found.key, label, accountId },
        'cron: removed drifted repeatable; will re-add',
      );
    } catch (err) {
      log.warn(
        { name, key: found.key, err: (err as Error).message },
        'cron: failed to remove drifted repeatable; will attempt add anyway',
      );
    }
  }

  await queueAdd(desiredPattern, desiredTimezone);
  log.info(
    { name, label, accountId, pattern: desiredPattern, tz: desiredTimezone },
    'cron: registered repeatable',
  );
}

/**
 * Pull `<accountId>` out of the convention-named `scheduled-paid-<id>` /
 * `scheduled-shipped-<id>`. Returns null if the job name doesn't match —
 * which lets us safely ignore manually-added repeatables.
 */
function extractAccountId(
  jobName: string,
  kind: 'paid' | 'shipped',
): string | null {
  const prefix = kind === 'paid' ? 'scheduled-paid-' : 'scheduled-shipped-';
  if (!jobName.startsWith(prefix)) return null;
  const id = jobName.slice(prefix.length);
  return id.length > 0 ? id : null;
}

/**
 * Idempotently registers the daily-digest repeatable. The job-data payload
 * is just `{ kind: 'daily-digest' }` — the processor aggregates by querying
 * Run rows for the trailing 24 hours.
 */
async function ensureDailyDigest(timezone: string): Promise<void> {
  const existing = await dailyDigestQueue.getRepeatableJobs();
  const found = existing.find(
    (j) => j.name === DAILY_DIGEST_REPEAT_KEY_SUFFIX,
  );
  if (found) {
    const currentPattern = found.pattern ?? '';
    const currentTz = found.tz ?? '';
    if (currentPattern === DAILY_DIGEST_CRON && currentTz === timezone) {
      return;
    }
    try {
      await dailyDigestQueue.removeRepeatableByKey(found.key);
      log.info(
        { key: found.key },
        'cron: removed drifted daily-digest repeatable; will re-add',
      );
    } catch (err) {
      log.warn(
        { key: found.key, err: (err as Error).message },
        'cron: failed to remove drifted daily-digest repeatable',
      );
    }
  }

  await dailyDigestQueue.add(
    DAILY_DIGEST_REPEAT_KEY_SUFFIX,
    { kind: 'daily-digest' },
    {
      repeat: { pattern: DAILY_DIGEST_CRON, tz: timezone },
      jobId: 'daily-digest',
    },
  );
  log.info(
    {
      queue: QUEUE_DAILY_DIGEST,
      pattern: DAILY_DIGEST_CRON,
      tz: timezone,
    },
    'cron: registered daily-digest repeatable',
  );
}

// -----------------------------------------------------------------------------
// Test helpers (re-exported for unit tests; not used by the worker boot path)
// -----------------------------------------------------------------------------

export const __testing = {
  paidJobName,
  shippedJobName,
  paidJobId,
  shippedJobId,
  DAILY_DIGEST_CRON,
  QUEUE_SCRAPE_PAID,
  QUEUE_SCRAPE_SHIPPED,
};

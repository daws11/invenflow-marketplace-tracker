// Scrape-shipped (dikirim pass) processor — full implementation (PRD §7.4.2).
//
// Pipeline per job, in order:
//   1. C2b active-session guard. If a browser session is open for the same
//      account, defer this job by 60s and return.
//   2. Load the Account row. Fail loudly if missing (BullMQ retries).
//   3. Create a `Run` row with status=RUNNING, pass=SHIPPED,
//      triggeredBy=(manual|scheduled).
//   4. Build the InvenflowClient from persisted Settings; surface a clear
//      "configure InvenFlow connection" error if either setting is missing.
//   5. Spin up Stagehand and call `scrapeShipped(...)` from the Tokopedia
//      agent. (Shopee will land in C4 — different agent, same processor
//      shape.)
//   6. Upload the single list-view proof screenshot once and reuse the
//      returned `filename` as `screenshotUploadIds[0]` for every transition
//      call this run produces.
//   7. For each scraped invoice number:
//        - Look up the local `Order` by (accountId, invoiceNumber). Skip
//          with a log if not present (the order was probably ingested
//          before the sidecar was running, or by a different account).
//        - For each line item with `lifecycleState = INGESTED`, call the
//          transition engine, persist the outcome, and bump the right
//          aggregate counter.
//   8. Update Run with success/failure status, counts, and modelUsed.
//   9. Always close Stagehand and `rm -rf` the per-run screenshot dir.
//   10. Return a structured digest payload so a future C5 daily-digest cron
//       can compose the WA message without re-querying every run.
//
// Error-handling philosophy mirrors scrape-paid:
//   * SessionExpiredError    → flip Account.status, mark Run FAILED. No retry.
//   * InvenflowConfigError   → mark Run FAILED with config message. No retry.
//   * InvenflowApiError      → mark Run FAILED. The client already exhausted
//                              retries on retryable codes; 4xx are fatal.
//   * ScrapeFailedError / *  → mark Run FAILED. Cron will run again.
//
// Per-line transition errors do NOT fail the run — they get persisted as
// `lifecycleState = SYNC_FAILED` on the row so the operator can replay them
// later (UI in C5).

import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  AccountStatus,
  type LifecycleState,
  Platform as PrismaPlatform,
  RunPass,
  RunStatus,
  TriggerType,
} from '@prisma/client';
import type { Job } from 'bullmq';

import {
  ScrapeFailedError,
  SessionExpiredError,
  type ShippedOrder,
} from '../../agents/_common.js';
import { scrapeShipped as scrapeShopeeShipped } from '../../agents/shopee.js';
import { scrapeShipped as scrapeTokopediaShipped } from '../../agents/tokopedia.js';
import { createStagehand } from '../../browser/factory.js';
import { type Platform as ProfilePlatform } from '../../browser/profile-manager.js';
import { prisma } from '../../lib/db.js';
import { getInvenflowClient, InvenflowConfigError } from '../../lib/invenflow.js';
import { InvenflowApiError } from '../../lib/invenflow-client.js';
import { childLogger } from '../../lib/logger.js';
import {
  transitionShippedOrder,
  type TransitionOutcome,
} from '../../lifecycle/transition-engine.js';
import { getRedisConnection } from '../connection.js';
import {
  QUEUE_SCRAPE_SHIPPED,
  type JobResult,
  type ScrapeShippedJobData,
} from '../queues.js';
import { activeKey } from '../session-state.js';

const log = childLogger(`queue:${QUEUE_SCRAPE_SHIPPED}`);

const DEFER_DELAY_MS = 60_000;

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/** Maps Prisma's `Platform` enum to the Stagehand factory profile platform. */
function profilePlatformFor(p: PrismaPlatform): ProfilePlatform {
  return p === PrismaPlatform.TOKOPEDIA ? 'tokopedia' : 'shopee';
}

/**
 * Dispatch the shipped-pass scraper by `Account.platform`. Both agents share
 * the same `(stagehand, ScrapeShippedOptions) → ScrapeShippedResult`
 * signature, so the call site is platform-agnostic from here on. The
 * `satisfies never` default branch is a compile-time guard: if a new
 * Platform enum value is added without a corresponding scraper, this file
 * will fail to typecheck.
 */
function getShippedScraper(
  platform: PrismaPlatform,
): typeof scrapeTokopediaShipped {
  switch (platform) {
    case PrismaPlatform.TOKOPEDIA:
      return scrapeTokopediaShipped;
    case PrismaPlatform.SHOPEE:
      return scrapeShopeeShipped;
    default: {
      const _exhaustive: never = platform;
      throw new Error(`Unsupported platform: ${_exhaustive}`);
    }
  }
}

/**
 * Per-account digest entry — emitted as the job result so a future
 * daily-digest cron (C5) can compose the WA message without re-querying
 * every run row.
 */
export interface ScrapeShippedDigest {
  accountId: string;
  /** Lines we successfully moved (200 OK, transitioned=true). */
  transitioned: number;
  /** Lines that came back 200 OK with transitioned=false (idempotent). */
  alreadyShipped: number;
  /** Lines where InvenFlow returned 409 OPERATOR_MOVED. */
  operatorMoved: number;
  /** Lines whose transition call ultimately failed. */
  failed: number;
  /** Scraped invoices that have no local match (skipped with a log). */
  skippedNoMatch: number;
  /** Per-case detail for the operator-moved lines (for the digest text). */
  operatorMovedCases: Array<{
    invoiceNumber: string;
    lineItemId: string;
    currentColumn: string;
  }>;
}

// -----------------------------------------------------------------------------
// Entry point
// -----------------------------------------------------------------------------

export async function processScrapeShippedJob(
  job: Job<ScrapeShippedJobData, JobResult>,
): Promise<JobResult> {
  const { accountId, triggeredBy } = job.data;

  // 1. Active-session guard (PRD §7.3.3).
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
    { jobId: job.id, accountId, triggeredBy },
    'scrape-shipped: starting run',
  );

  // 2. Load Account.
  const account = await prisma.account.findUnique({
    where: { id: accountId },
  });
  if (!account) {
    throw new Error(`Account ${accountId} not found`);
  }

  // 3. Create the Run row up-front so a crash inside Stagehand still leaves
  //    a discoverable failed record in run history.
  const run = await prisma.run.create({
    data: {
      accountId,
      pass: RunPass.SHIPPED,
      status: RunStatus.RUNNING,
      triggeredBy:
        triggeredBy === 'manual' ? TriggerType.MANUAL : TriggerType.SCHEDULED,
    },
  });

  const screenshotDir = join(tmpdir(), 'screenshots', run.id);

  // Mutable accumulators so the catch / finally can finalize Run + digest.
  let stagehand: Awaited<ReturnType<typeof createStagehand>> | null = null;
  let modelUsed: string | undefined;

  const digest: ScrapeShippedDigest = {
    accountId,
    transitioned: 0,
    alreadyShipped: 0,
    operatorMoved: 0,
    failed: 0,
    skippedNoMatch: 0,
    operatorMovedCases: [],
  };

  try {
    // 4. Build the InvenflowClient.
    const invenflow = await getInvenflowClient();

    // 5. Spin up Stagehand for this account's persistent profile.
    stagehand = await createStagehand({
      platform: profilePlatformFor(account.platform),
      accountId,
      interactive: false,
    });

    // C4: dispatch by platform — Tokopedia + Shopee both supported. The
    // dispatcher's `satisfies never` default branch ensures any new Platform
    // enum value will fail compilation here.
    const scrapeShipped = getShippedScraper(account.platform);

    const scrape = await scrapeShipped(stagehand, {
      accountId,
      runId: run.id,
      shippedUrlOverride: account.shippedUrlOverride,
      screenshotDir,
    });
    modelUsed = scrape.modelUsed;

    // 6. Upload the single proof screenshot once and reuse for every line
    //    transition this run. Skip orders entirely if the screenshot is
    //    unreadable AND we have shipped orders to process — InvenFlow
    //    accepts an empty `screenshotUploadIds` array, so we degrade
    //    gracefully and log instead of aborting.
    let screenshotUploadIds: string[] = [];
    if (scrape.orders.length > 0) {
      const firstScreenshotPath = scrape.orders[0]?.screenshotPath;
      if (firstScreenshotPath) {
        try {
          const { readFile } = await import('node:fs/promises');
          const buf = await readFile(firstScreenshotPath);
          // Friendly filename — InvenFlow only uses the returned
          // `file.filename` as the upload id; this is for human eyeballs.
          const originalName = `${run.id}-shipped-list.png`;
          const uploaded = await invenflow.uploadFile(
            buf,
            originalName,
            'image/png',
          );
          screenshotUploadIds = [uploaded.file.filename];
        } catch (err) {
          log.warn(
            {
              runId: run.id,
              filePath: firstScreenshotPath,
              err: (err as Error).message,
            },
            'scrape-shipped: proof screenshot unreadable / upload failed; transitioning without proof',
          );
        }
      }
    }

    // 7. Per-invoice transition.
    for (const shipped of scrape.orders) {
      try {
        await processShippedInvoice({
          shipped,
          account,
          invenflow,
          screenshotUploadIds,
          digest,
        });
      } catch (err) {
        // A single-invoice crash shouldn't kill the whole run; log it and
        // bump `failed` so the digest reflects reality.
        log.error(
          {
            runId: run.id,
            invoiceNumber: shipped.invoiceNumber,
            err: (err as Error).message,
          },
          'scrape-shipped: invoice processing crashed; counting as failed',
        );
        digest.failed += 1;
      }
    }

    // 8. Mark Run successful. `transitionCount` per the brief is
    //    transitioned + alreadyShipped (every line we observed in the
    //    target state at the end of the run).
    await prisma.run.update({
      where: { id: run.id },
      data: {
        status: RunStatus.SUCCESS,
        completedAt: new Date(),
        modelUsed: modelUsed ?? null,
        transitionCount: digest.transitioned + digest.alreadyShipped,
        failedSyncs: digest.failed,
      },
    });

    log.info(
      { runId: run.id, ...digest, modelUsed },
      'scrape-shipped: run complete',
    );

    return {
      ok: true,
      message: 'scrape-shipped run succeeded',
      data: { runId: run.id, digest, modelUsed: modelUsed ?? null },
    };
  } catch (err) {
    // 9. Failure cases. Don't rethrow — see file header rationale.
    if (err instanceof SessionExpiredError) {
      await prisma.account.update({
        where: { id: accountId },
        data: { status: AccountStatus.SESSION_EXPIRED },
      });
      await prisma.run.update({
        where: { id: run.id },
        data: {
          status: RunStatus.FAILED,
          completedAt: new Date(),
          modelUsed: modelUsed ?? null,
          transitionCount: digest.transitioned + digest.alreadyShipped,
          failedSyncs: digest.failed,
          errorMessage: 'Session expired — re-login required.',
        },
      });
      log.warn(
        { runId: run.id, accountId, currentUrl: err.currentUrl },
        'scrape-shipped: session expired; account flagged',
      );
      return {
        ok: false,
        message: 'session expired',
        data: { runId: run.id, digest, reason: 'SESSION_EXPIRED' },
      };
    }

    if (err instanceof InvenflowConfigError) {
      await prisma.run.update({
        where: { id: run.id },
        data: {
          status: RunStatus.FAILED,
          completedAt: new Date(),
          modelUsed: modelUsed ?? null,
          transitionCount: digest.transitioned + digest.alreadyShipped,
          failedSyncs: digest.failed,
          errorMessage: err.message,
        },
      });
      log.error(
        { runId: run.id, accountId, err: err.message },
        'scrape-shipped: invenflow config missing',
      );
      return {
        ok: false,
        message: 'invenflow config missing',
        data: { runId: run.id, digest, reason: 'INVENFLOW_CONFIG_MISSING' },
      };
    }

    if (err instanceof InvenflowApiError) {
      const errorMessage = err.code
        ? `InvenFlow ${err.status} ${err.code}: ${err.message}`
        : `InvenFlow ${err.status}: ${err.message}`;
      await prisma.run.update({
        where: { id: run.id },
        data: {
          status: RunStatus.FAILED,
          completedAt: new Date(),
          modelUsed: modelUsed ?? null,
          transitionCount: digest.transitioned + digest.alreadyShipped,
          failedSyncs: digest.failed,
          errorMessage,
        },
      });
      log.error(
        { runId: run.id, accountId, status: err.status, code: err.code },
        'scrape-shipped: invenflow API error',
      );
      return {
        ok: false,
        message: 'invenflow API error',
        data: {
          runId: run.id,
          digest,
          status: err.status,
          code: err.code,
        },
      };
    }

    // ScrapeFailedError or anything else.
    const message =
      err instanceof ScrapeFailedError
        ? `Scrape failed: ${err.message}`
        : `Unexpected error: ${(err as Error).message}`;
    await prisma.run.update({
      where: { id: run.id },
      data: {
        status: RunStatus.FAILED,
        completedAt: new Date(),
        modelUsed: modelUsed ?? null,
        transitionCount: digest.transitioned + digest.alreadyShipped,
        failedSyncs: digest.failed,
        errorMessage: message,
      },
    });
    log.error(
      { runId: run.id, accountId, err: (err as Error).message },
      'scrape-shipped: run failed',
    );
    return {
      ok: false,
      message: 'scrape-shipped failed',
      data: { runId: run.id, digest, reason: 'SCRAPE_FAILED' },
    };
  } finally {
    // 10. Always release the browser + clean up screenshots.
    if (stagehand) {
      try {
        await stagehand.close();
      } catch (err) {
        log.warn(
          { runId: run.id, err: (err as Error).message },
          'scrape-shipped: stagehand.close() failed (non-fatal)',
        );
      }
    }
    try {
      await rm(screenshotDir, { recursive: true, force: true });
    } catch (err) {
      log.warn(
        { runId: run.id, screenshotDir, err: (err as Error).message },
        'scrape-shipped: screenshot cleanup failed (non-fatal)',
      );
    }
  }
}

// -----------------------------------------------------------------------------
// Per-invoice helper
// -----------------------------------------------------------------------------

interface ProcessShippedInvoiceArgs {
  shipped: ShippedOrder;
  account: {
    id: string;
    columnOnPaid: string;
    columnOnShipped: string;
  };
  invenflow: Awaited<ReturnType<typeof getInvenflowClient>>;
  screenshotUploadIds: string[];
  digest: ScrapeShippedDigest;
}

async function processShippedInvoice(
  args: ProcessShippedInvoiceArgs,
): Promise<void> {
  const { shipped, account, invenflow, screenshotUploadIds, digest } = args;

  // 1. Find the local Order. If we never ingested it (e.g. ingested before
  //    this sidecar was running), there's nothing for us to transition —
  //    log + skip.
  const order = await prisma.order.findUnique({
    where: {
      accountId_invoiceNumber: {
        accountId: account.id,
        invoiceNumber: shipped.invoiceNumber,
      },
    },
    include: { lineItems: true },
  });

  if (!order) {
    log.info(
      {
        accountId: account.id,
        invoiceNumber: shipped.invoiceNumber,
      },
      'scrape-shipped: invoice not in local DB; possibly ingested before this sidecar was running — skipping',
    );
    digest.skippedNoMatch += 1;
    return;
  }

  // 2. Filter to lines that are still in INGESTED. Any other state is
  //    deliberately respected: SHIPPED_CONFIRMED is idempotent done,
  //    SHIPPED_BUT_OPERATOR_MOVED is "operator already handled it", and
  //    SYNC_FAILED is "leave for manual retry in the UI" (C5).
  const candidates = order.lineItems.filter(
    (li) => (li.lifecycleState as LifecycleState) === 'INGESTED',
  );

  if (candidates.length === 0) {
    log.debug(
      {
        invoiceNumber: shipped.invoiceNumber,
        totalLineItems: order.lineItems.length,
      },
      'scrape-shipped: no INGESTED line items for invoice; nothing to transition',
    );
    return;
  }

  for (const li of candidates) {
    const outcome: TransitionOutcome = await transitionShippedOrder(
      invenflow,
      account,
      {
        orderLineItemId: li.id,
        invoiceNumber: shipped.invoiceNumber,
        externalLineItemId: li.lineItemId,
      },
      screenshotUploadIds,
    );

    await persistOutcome(li.id, outcome);
    bumpDigest(digest, outcome, {
      invoiceNumber: shipped.invoiceNumber,
      lineItemId: li.lineItemId,
    });
  }
}

/** Persist the outcome on the OrderLineItem row. */
async function persistOutcome(
  orderLineItemId: string,
  outcome: TransitionOutcome,
): Promise<void> {
  const now = new Date();
  switch (outcome.state) {
    case 'SHIPPED_CONFIRMED':
      await prisma.orderLineItem.update({
        where: { id: orderLineItemId },
        data: {
          lifecycleState: 'SHIPPED_CONFIRMED',
          shippedAt: now,
          lastSyncError: null,
        },
      });
      return;
    case 'SHIPPED_BUT_OPERATOR_MOVED':
      await prisma.orderLineItem.update({
        where: { id: orderLineItemId },
        data: {
          lifecycleState: 'SHIPPED_BUT_OPERATOR_MOVED',
          shippedAt: now,
        },
      });
      return;
    case 'SYNC_FAILED':
      await prisma.orderLineItem.update({
        where: { id: orderLineItemId },
        data: {
          lifecycleState: 'SYNC_FAILED',
          lastSyncError: outcome.error,
          syncRetryCount: { increment: 1 },
        },
      });
      return;
  }
}

/** Increment digest counters + capture per-case detail. */
function bumpDigest(
  digest: ScrapeShippedDigest,
  outcome: TransitionOutcome,
  ctx: { invoiceNumber: string; lineItemId: string },
): void {
  switch (outcome.state) {
    case 'SHIPPED_CONFIRMED':
      if (outcome.transitioned) {
        digest.transitioned += 1;
      } else {
        digest.alreadyShipped += 1;
      }
      return;
    case 'SHIPPED_BUT_OPERATOR_MOVED':
      digest.operatorMoved += 1;
      digest.operatorMovedCases.push({
        invoiceNumber: ctx.invoiceNumber,
        lineItemId: ctx.lineItemId,
        currentColumn: outcome.currentColumn,
      });
      return;
    case 'SYNC_FAILED':
      digest.failed += 1;
      return;
  }
}

// Scrape-paid (dibayar pass) processor — full implementation (PRD §7.4.1).
//
// Pipeline per job, in order:
//   1. C2b active-session guard. If a browser session is open for the same
//      account, defer this job by 60s and return.
//   2. Load the Account row. Fail loudly if missing.
//   3. Create a `Run` row with status=RUNNING, pass=PAID,
//      triggeredBy=(manual|scheduled).
//   4. Build the InvenflowClient from persisted Settings; surface a clear
//      "configure InvenFlow connection" error if either setting is missing.
//   5. Spin up Stagehand and call `scrapePaid(...)` from the Tokopedia
//      agent. (Shopee will land in C4 — different agent, same processor
//      shape.)
//   6. For each scraped order:
//        - upload the screenshot once (cache by path so multiple orders
//          sharing a list-view screenshot only upload once).
//        - assemble the IngestOrderRequest payload.
//        - call POST /api/marketplace/orders. Per contract §3.2 the
//          endpoint resolves SKU mappings server-side, so we do not call
//          /resolve from here (saves one round-trip per line).
//        - upsert local Order + OrderLineItem rows.
//   7. Update Run with success/failure status, counts, and modelUsed.
//   8. Always close Stagehand and `rm -rf` the per-run screenshot dir.
//
// Error-handling philosophy (per brief):
//   * SessionExpiredError → set Account.status=SESSION_EXPIRED, mark Run
//     FAILED, do NOT rethrow (no retry — needs human intervention).
//   * InvenflowApiError (any 4xx, including auth/permission) → mark Run
//     FAILED, do NOT rethrow (the InvenflowClient already exhausted retries
//     for retryable codes; 4xx are non-retryable by contract §3.3).
//   * InvenflowConfigError → mark Run FAILED, do NOT rethrow.
//   * Anything else → mark Run FAILED, do NOT rethrow. Cron will run again
//     on schedule; we don't want BullMQ to spin retries on top of that.
//
// The processor returns the run id + counts so the caller (UI on a manual
// trigger) can navigate to the run-history page (PRD §7.10).

import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  AccountStatus,
  type LifecycleState,
  Platform as PrismaPlatform,
  Prisma,
  RunPass,
  RunStatus,
  TriggerType,
} from '@prisma/client';
import type { Job } from 'bullmq';

import { scrapePaid, ScrapeFailedError, SessionExpiredError, type ScrapedOrder } from '../../agents/tokopedia.js';
import { createStagehand } from '../../browser/factory.js';
import { type Platform as ProfilePlatform } from '../../browser/profile-manager.js';
import { prisma } from '../../lib/db.js';
import { getInvenflowClient, InvenflowConfigError } from '../../lib/invenflow.js';
import { InvenflowApiError } from '../../lib/invenflow-client.js';
import { childLogger } from '../../lib/logger.js';
import type {
  IngestLineItem,
  IngestLineResult,
  IngestOrderRequest,
  IngestOrderResponse,
  Platform as WirePlatform,
} from '../../types/invenflow-api.js';
import { getRedisConnection } from '../connection.js';
import {
  QUEUE_SCRAPE_PAID,
  type JobResult,
  type ScrapePaidJobData,
} from '../queues.js';
import { activeKey } from '../session-state.js';

const log = childLogger(`queue:${QUEUE_SCRAPE_PAID}`);

const DEFER_DELAY_MS = 60_000;

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/** Maps Prisma's `Platform` enum to the Stagehand factory profile platform. */
function profilePlatformFor(p: PrismaPlatform): ProfilePlatform {
  return p === PrismaPlatform.TOKOPEDIA ? 'tokopedia' : 'shopee';
}

/** Maps Prisma's `Platform` enum to the wire-level platform string. */
function wirePlatformFor(p: PrismaPlatform): WirePlatform {
  return p === PrismaPlatform.TOKOPEDIA ? 'tokopedia' : 'shopee';
}

/**
 * Builds a stable line-item id per contract §4.6:
 * `<platform>-<invoiceNumber-stripped-of-slashes>-line<N>`.
 * The 1-based index matches the example payload.
 */
function buildLineItemId(
  platform: WirePlatform,
  invoiceNumber: string,
  index1Based: number,
): string {
  // Strip slashes and any other path-unsafe punctuation, but keep
  // alphanumerics + dashes so the id stays human-readable in logs.
  const stripped = invoiceNumber.replace(/[^A-Za-z0-9-]/g, '');
  return `${platform}-${stripped}-line${index1Based}`;
}

/**
 * Per-run cache: each list-view screenshot is uploaded exactly once even
 * if multiple orders point at the same path.
 */
type UploadCache = Map<string, string>;

// -----------------------------------------------------------------------------
// Entry point
// -----------------------------------------------------------------------------

export async function processScrapePaidJob(
  job: Job<ScrapePaidJobData, JobResult>,
): Promise<JobResult> {
  const { accountId, triggeredBy } = job.data;

  // 1. Active-session guard (PRD §7.3.3).
  const redis = getRedisConnection();
  const activeSessionId = await redis.get(activeKey(accountId));
  if (activeSessionId) {
    await job.moveToDelayed(Date.now() + DEFER_DELAY_MS);
    log.info(
      { accountId, sessionId: activeSessionId, jobId: job.id },
      'session active; deferring scrape-paid by 60s',
    );
    return { ok: true, message: 'deferred (browser session active)' };
  }

  log.info(
    { jobId: job.id, accountId, triggeredBy },
    'scrape-paid: starting run',
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
      pass: RunPass.PAID,
      status: RunStatus.RUNNING,
      triggeredBy: triggeredBy === 'manual' ? TriggerType.MANUAL : TriggerType.SCHEDULED,
    },
  });

  const screenshotDir = join(tmpdir(), 'screenshots', run.id);

  // Mutable result accumulator so the catch / finally can finalize Run.
  let stagehand: Awaited<ReturnType<typeof createStagehand>> | null = null;
  let modelUsed: string | undefined;
  let orderCount = 0;
  let newOrderCount = 0;

  try {
    // 4. Build the InvenflowClient. Throws InvenflowConfigError if the
    //    Settings rows are missing — caught below.
    const invenflow = await getInvenflowClient();

    // 5. Spin up Stagehand for this account's persistent profile.
    stagehand = await createStagehand({
      platform: profilePlatformFor(account.platform),
      accountId,
      interactive: false,
    });

    // C3a is Tokopedia-only; Shopee lands in C4.
    if (account.platform !== PrismaPlatform.TOKOPEDIA) {
      throw new Error(
        `scrape-paid: only TOKOPEDIA is supported in C3a; got ${account.platform}`,
      );
    }

    const scrape = await scrapePaid(stagehand, {
      accountId,
      runId: run.id,
      paidUrlOverride: account.paidUrlOverride,
      screenshotDir,
    });
    modelUsed = scrape.modelUsed;
    orderCount = scrape.orders.length;

    // 6. Per-order ingest + local persistence.
    const uploadCache: UploadCache = new Map();
    const wirePlatform = wirePlatformFor(account.platform);

    for (const order of scrape.orders) {
      try {
        const result = await ingestAndPersistOrder({
          order,
          run,
          account,
          invenflow,
          uploadCache,
          wirePlatform,
          modelUsed,
        });
        if (result.newOrders > 0) newOrderCount += result.newOrders;
      } catch (err) {
        // A single-order failure shouldn't kill the whole run.
        log.error(
          {
            runId: run.id,
            invoiceNumber: order.invoiceNumber,
            err: (err as Error).message,
          },
          'scrape-paid: failed to ingest order; skipping',
        );
        await prisma.run.update({
          where: { id: run.id },
          data: { failedSyncs: { increment: order.lineItems.length } },
        });
      }
    }

    // 7. Mark Run successful.
    await prisma.run.update({
      where: { id: run.id },
      data: {
        status: RunStatus.SUCCESS,
        completedAt: new Date(),
        modelUsed: modelUsed ?? null,
        orderCount,
        newOrderCount,
      },
    });

    log.info(
      { runId: run.id, orderCount, newOrderCount, modelUsed },
      'scrape-paid: run complete',
    );

    return {
      ok: true,
      message: 'scrape-paid run succeeded',
      data: { runId: run.id, orderCount, newOrderCount, modelUsed },
    };
  } catch (err) {
    // 8. Failure cases. Don't rethrow — see file header rationale.
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
          orderCount,
          newOrderCount,
          errorMessage: 'Session expired — re-login required.',
        },
      });
      log.warn(
        { runId: run.id, accountId, currentUrl: err.currentUrl },
        'scrape-paid: session expired; account flagged',
      );
      return {
        ok: false,
        message: 'session expired',
        data: { runId: run.id, reason: 'SESSION_EXPIRED' },
      };
    }

    if (err instanceof InvenflowConfigError) {
      await prisma.run.update({
        where: { id: run.id },
        data: {
          status: RunStatus.FAILED,
          completedAt: new Date(),
          modelUsed: modelUsed ?? null,
          orderCount,
          newOrderCount,
          errorMessage: err.message,
        },
      });
      log.error(
        { runId: run.id, accountId, err: err.message },
        'scrape-paid: invenflow config missing',
      );
      return {
        ok: false,
        message: 'invenflow config missing',
        data: { runId: run.id, reason: 'INVENFLOW_CONFIG_MISSING' },
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
          orderCount,
          newOrderCount,
          errorMessage,
        },
      });
      log.error(
        { runId: run.id, accountId, status: err.status, code: err.code },
        'scrape-paid: invenflow API error',
      );
      return {
        ok: false,
        message: 'invenflow API error',
        data: { runId: run.id, status: err.status, code: err.code },
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
        orderCount,
        newOrderCount,
        errorMessage: message,
      },
    });
    log.error(
      { runId: run.id, accountId, err: (err as Error).message },
      'scrape-paid: run failed',
    );
    return {
      ok: false,
      message: 'scrape-paid failed',
      data: { runId: run.id, reason: 'SCRAPE_FAILED' },
    };
  } finally {
    // 9. Always release the browser + clean up screenshots.
    if (stagehand) {
      try {
        await stagehand.close();
      } catch (err) {
        log.warn(
          { runId: run.id, err: (err as Error).message },
          'scrape-paid: stagehand.close() failed (non-fatal)',
        );
      }
    }
    try {
      await rm(screenshotDir, { recursive: true, force: true });
    } catch (err) {
      log.warn(
        { runId: run.id, screenshotDir, err: (err as Error).message },
        'scrape-paid: screenshot cleanup failed (non-fatal)',
      );
    }
  }
}

// -----------------------------------------------------------------------------
// Per-order helper
// -----------------------------------------------------------------------------

interface IngestAndPersistArgs {
  order: ScrapedOrder;
  run: { id: string };
  account: {
    id: string;
    platform: PrismaPlatform;
    invenflowKanbanId: string;
    columnOnPaid: string;
  };
  invenflow: Awaited<ReturnType<typeof getInvenflowClient>>;
  uploadCache: UploadCache;
  wirePlatform: WirePlatform;
  modelUsed: string | undefined;
}

async function ingestAndPersistOrder(
  args: IngestAndPersistArgs,
): Promise<{ newOrders: number }> {
  const { order, run, account, invenflow, uploadCache, wirePlatform, modelUsed } = args;

  // 1. Upload the screenshot (or reuse cached upload id).
  const uploadId = await uploadScreenshotIfNeeded(
    invenflow,
    uploadCache,
    order.screenshotPath,
    order.invoiceNumber,
  );

  // 2. Build the ingest payload.
  const ingestLineItems: IngestLineItem[] = order.lineItems.map((li, idx) => ({
    lineItemId: buildLineItemId(wirePlatform, order.invoiceNumber, idx + 1),
    marketplaceProductName: li.marketplaceProductName,
    marketplaceProductUrl: li.marketplaceProductUrl,
    quantity: li.quantity,
    unitPrice: li.unitPrice,
    subtotal: li.subtotal,
  }));

  const payload: IngestOrderRequest = {
    platform: wirePlatform,
    kanbanId: account.invenflowKanbanId,
    targetColumnStatus: account.columnOnPaid,
    invoiceNumber: order.invoiceNumber,
    orderDate: order.orderDate,
    sellerName: order.sellerName,
    lineItems: ingestLineItems,
    shippingFee: order.shippingFee ?? undefined,
    discount: order.discount ?? undefined,
    totalAmount: order.totalAmount,
    screenshotUploadIds: uploadId ? [uploadId] : [],
    rawData: {
      extractedBy: 'stagehand',
      ...(modelUsed ? { modelUsed } : {}),
      scrapedAt: new Date().toISOString(),
      ...(order.detailUrl ? { detailUrl: order.detailUrl } : {}),
    },
  };

  // 3. Send. The InvenflowClient handles 429/5xx retries internally.
  const response: IngestOrderResponse = await invenflow.ingestOrder(payload);

  // 4. Persist locally — Order + OrderLineItem upserts (idempotent).
  let newOrders = 0;
  for (const lineResult of response.lineItems) {
    if (lineResult.isNew) newOrders += 1;
  }

  // Order: unique by (accountId, invoiceNumber).
  const existingOrder = await prisma.order.findUnique({
    where: {
      accountId_invoiceNumber: {
        accountId: account.id,
        invoiceNumber: order.invoiceNumber,
      },
    },
  });

  // Build the rawData JSON we store on Order. `rawData` is required (Json,
  // non-nullable in schema), so always provide it. We round-trip through
  // JSON.stringify so Prisma's `InputJsonValue` is happy regardless of any
  // exotic types (Decimal, Date, custom classes) that might creep into
  // sub-objects.
  const orderRawData = JSON.parse(
    JSON.stringify({
      detailUrl: order.detailUrl,
      rawLineItems: order.lineItems,
      ingestResponse: response.lineItems,
      scrapedAt: new Date().toISOString(),
    }),
  ) as Prisma.InputJsonValue;

  let orderRow;
  if (existingOrder) {
    orderRow = await prisma.order.update({
      where: { id: existingOrder.id },
      data: {
        runId: run.id,
        orderDate: new Date(order.orderDate),
        sellerName: order.sellerName,
        totalAmount: order.totalAmount,
        shippingFee: order.shippingFee ?? null,
        discount: order.discount ?? null,
        rawData: orderRawData,
      },
    });
  } else {
    orderRow = await prisma.order.create({
      data: {
        runId: run.id,
        accountId: account.id,
        invoiceNumber: order.invoiceNumber,
        orderDate: new Date(order.orderDate),
        sellerName: order.sellerName,
        totalAmount: order.totalAmount,
        shippingFee: order.shippingFee ?? null,
        discount: order.discount ?? null,
        rawData: orderRawData,
      },
    });
  }

  // OrderLineItem: unique by (orderId, lineItemId).
  for (const [idx, li] of order.lineItems.entries()) {
    const lineItemId = buildLineItemId(
      wirePlatform,
      order.invoiceNumber,
      idx + 1,
    );
    const matched: IngestLineResult | undefined = response.lineItems.find(
      (lr) => lr.lineItemId === lineItemId,
    );

    const ingestedAt = new Date();
    const lifecycleState: LifecycleState = 'INGESTED';

    await prisma.orderLineItem.upsert({
      where: {
        orderId_lineItemId: {
          orderId: orderRow.id,
          lineItemId,
        },
      },
      create: {
        orderId: orderRow.id,
        lineItemId,
        marketplaceProductName: li.marketplaceProductName,
        marketplaceProductUrl: li.marketplaceProductUrl,
        quantity: li.quantity,
        unitPrice: li.unitPrice,
        subtotal: li.subtotal,
        invenflowProductId: matched?.invenflowProductId ?? null,
        needsSkuMapping: matched?.needsSkuMapping ?? false,
        lifecycleState,
        ingestedAt,
      },
      update: {
        marketplaceProductName: li.marketplaceProductName,
        marketplaceProductUrl: li.marketplaceProductUrl,
        quantity: li.quantity,
        unitPrice: li.unitPrice,
        subtotal: li.subtotal,
        invenflowProductId: matched?.invenflowProductId ?? null,
        needsSkuMapping: matched?.needsSkuMapping ?? false,
        lifecycleState,
        ingestedAt,
        // Clear any prior failure metadata on a successful re-ingest.
        lastSyncError: null,
        syncRetryCount: 0,
      },
    });
  }

  return { newOrders };
}

/**
 * Reads the file at `path`, uploads via InvenFlow §4.4, and returns the
 * upload id (`file.filename`). Subsequent calls with the same path return
 * the cached id without re-uploading.
 */
async function uploadScreenshotIfNeeded(
  invenflow: Awaited<ReturnType<typeof getInvenflowClient>>,
  cache: UploadCache,
  filePath: string,
  invoiceNumber: string,
): Promise<string | null> {
  const cached = cache.get(filePath);
  if (cached) return cached;

  // Read the file lazily so a missing screenshot doesn't kill the whole
  // ingest call — surface a warning, attach no upload, and continue.
  const { readFile } = await import('node:fs/promises');
  let buf: Buffer;
  try {
    buf = await readFile(filePath);
  } catch (err) {
    log.warn(
      { invoiceNumber, filePath, err: (err as Error).message },
      'scrape-paid: screenshot file unreadable; ingesting without it',
    );
    return null;
  }

  // Friendly filename — InvenFlow only uses the returned `file.filename`
  // as the upload id, so the originalname is for human eyeballs.
  const originalName = `${invoiceNumber.replace(/[^A-Za-z0-9-]/g, '_')}.png`;
  const uploaded = await invenflow.uploadFile(buf, originalName, 'image/png');
  const uploadId = uploaded.file.filename;
  cache.set(filePath, uploadId);
  return uploadId;
}

// Ingest one scraped marketplace order: push it to InvenFlow
// (POST /api/marketplace/orders) and upsert the local Order + OrderLineItem
// rows. This is the apps/web counterpart of the worker's
// `ingestAndPersistOrder` (apps/worker/src/queue/processors/scrape-paid.ts) —
// used by `POST /api/ingest`, the Chrome-extension ingest path. The
// `lineItemId` derivation is kept byte-identical to the worker's so an order
// re-ingested via the extension lines up with any rows the worker created.

import { type LifecycleState, Prisma } from '@prisma/client';

import { prisma } from '@/lib/db';
import type { InvenflowClient } from '@/lib/invenflow-client';
import type {
  IngestLineItem,
  IngestLineResult,
  IngestOrderRequest,
  IngestOrderResponse,
  Platform as WirePlatform,
} from '@/types/invenflow-api';

export interface ScrapedLineItemInput {
  marketplaceProductName: string;
  marketplaceProductUrl?: string | null;
  /** Integer count of units (>= 1). */
  quantity: number;
  /** Integer rupiah, no decimals. */
  unitPrice: number;
  /** Integer rupiah, no decimals. */
  subtotal: number;
}

export interface ScrapedOrderInput {
  invoiceNumber: string;
  /** ISO 8601 timestamp or `YYYY-MM-DD`. */
  orderDate: string;
  sellerName?: string | null;
  lineItems: ScrapedLineItemInput[];
  shippingFee?: number | null;
  discount?: number | null;
  totalAmount: number;
  detailUrl?: string | null;
  /** Base64-encoded PNG screenshot (no `data:` prefix). Optional. */
  screenshotBase64?: string;
}

export interface PersistOrderContext {
  runId: string;
  accountId: string;
  invenflowKanbanId: string;
  /** Target column for the paid pass (= `Account.columnOnPaid`). */
  columnOnPaid: string;
  platform: WirePlatform;
  invenflow: InvenflowClient;
}

/**
 * Stable line-item id per the InvenFlow integration contract §4.6:
 * `<platform>-<invoiceNumber-stripped-of-non-alnum>-line<N>`, 1-based index.
 * MUST stay identical to the worker's `buildLineItemId`.
 */
export function buildLineItemId(
  platform: WirePlatform,
  invoiceNumber: string,
  index1Based: number,
): string {
  const stripped = invoiceNumber.replace(/[^A-Za-z0-9-]/g, '');
  return `${platform}-${stripped}-line${index1Based}`;
}

/**
 * Ingest one scraped order. Returns the count of *new* line items reported by
 * InvenFlow (used to bump `Run.newOrderCount`). Throws on InvenFlow API or DB
 * errors — the caller decides whether one bad order fails the whole run.
 */
export async function persistScrapedOrder(
  order: ScrapedOrderInput,
  ctx: PersistOrderContext,
): Promise<{ newOrders: number }> {
  const {
    runId,
    accountId,
    invenflowKanbanId,
    columnOnPaid,
    platform,
    invenflow,
  } = ctx;

  // 1. Optional screenshot upload.
  let screenshotUploadIds: string[] = [];
  if (order.screenshotBase64) {
    const buf = Buffer.from(order.screenshotBase64, 'base64');
    if (buf.length > 0) {
      const name = `${order.invoiceNumber.replace(/[^A-Za-z0-9-]/g, '_')}.png`;
      const uploaded = await invenflow.uploadFile(buf, name, 'image/png');
      screenshotUploadIds = [uploaded.file.filename];
    }
  }

  // 2. Build the ingest payload.
  const ingestLineItems: IngestLineItem[] = order.lineItems.map((li, idx) => ({
    lineItemId: buildLineItemId(platform, order.invoiceNumber, idx + 1),
    marketplaceProductName: li.marketplaceProductName,
    marketplaceProductUrl: li.marketplaceProductUrl ?? null,
    quantity: li.quantity,
    unitPrice: li.unitPrice,
    subtotal: li.subtotal,
  }));

  const payload: IngestOrderRequest = {
    platform,
    kanbanId: invenflowKanbanId,
    targetColumnStatus: columnOnPaid,
    invoiceNumber: order.invoiceNumber,
    orderDate: order.orderDate,
    sellerName: order.sellerName ?? null,
    lineItems: ingestLineItems,
    shippingFee: order.shippingFee ?? undefined,
    discount: order.discount ?? undefined,
    totalAmount: order.totalAmount,
    screenshotUploadIds,
    rawData: {
      extractedBy: 'extension',
      scrapedAt: new Date().toISOString(),
      ...(order.detailUrl ? { detailUrl: order.detailUrl } : {}),
    },
  };

  // 3. Send. InvenflowClient retries 429/5xx internally.
  const response: IngestOrderResponse = await invenflow.ingestOrder(payload);

  let newOrders = 0;
  for (const lineResult of response.lineItems) {
    if (lineResult.isNew) newOrders += 1;
  }

  // 4. Persist locally — Order + OrderLineItem upserts (idempotent).
  const orderRawData = JSON.parse(
    JSON.stringify({
      detailUrl: order.detailUrl ?? null,
      rawLineItems: order.lineItems,
      ingestResponse: response.lineItems,
      scrapedAt: new Date().toISOString(),
    }),
  ) as Prisma.InputJsonValue;

  const existingOrder = await prisma.order.findUnique({
    where: {
      accountId_invoiceNumber: { accountId, invoiceNumber: order.invoiceNumber },
    },
  });

  const orderRow = existingOrder
    ? await prisma.order.update({
        where: { id: existingOrder.id },
        data: {
          runId,
          orderDate: new Date(order.orderDate),
          sellerName: order.sellerName ?? null,
          totalAmount: order.totalAmount,
          shippingFee: order.shippingFee ?? null,
          discount: order.discount ?? null,
          rawData: orderRawData,
        },
      })
    : await prisma.order.create({
        data: {
          runId,
          accountId,
          invoiceNumber: order.invoiceNumber,
          orderDate: new Date(order.orderDate),
          sellerName: order.sellerName ?? null,
          totalAmount: order.totalAmount,
          shippingFee: order.shippingFee ?? null,
          discount: order.discount ?? null,
          rawData: orderRawData,
        },
      });

  for (const [idx, li] of order.lineItems.entries()) {
    const lineItemId = buildLineItemId(platform, order.invoiceNumber, idx + 1);
    const matched: IngestLineResult | undefined = response.lineItems.find(
      (lr) => lr.lineItemId === lineItemId,
    );
    const ingestedAt = new Date();
    const lifecycleState: LifecycleState = 'INGESTED';

    await prisma.orderLineItem.upsert({
      where: { orderId_lineItemId: { orderId: orderRow.id, lineItemId } },
      create: {
        orderId: orderRow.id,
        lineItemId,
        marketplaceProductName: li.marketplaceProductName,
        marketplaceProductUrl: li.marketplaceProductUrl ?? null,
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
        marketplaceProductUrl: li.marketplaceProductUrl ?? null,
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

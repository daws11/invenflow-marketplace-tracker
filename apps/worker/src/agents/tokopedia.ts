// Tokopedia agent — paid + shipped scrapes (PRD §7.4.1 / §7.4.2).
//
// C3a implemented PASS A (status `dibayar` / paid, awaiting shipment).
// C3b adds PASS B (`dikirim` / shipped). The Stagehand instance is
// constructed by the caller via `apps/worker/src/browser/factory.ts` so the
// per-account profile, anti-detection args (PRD §13), and AI config (PRD
// §11) are inherited from a single source of truth.
//
// Public contract — used by the scrape-paid / scrape-shipped processors:
//   * `scrapePaid(stagehand, opts)` returns `{ orders, modelUsed }`.
//   * `scrapeShipped(stagehand, opts)` returns `{ orders, modelUsed }` for
//     the dikirim list (lighter schema — invoice + detail URL only).
//   * `SessionExpiredError` thrown when the session cookie is invalid (page
//     redirects to the login URL on navigation). Processor catches this and
//     flips Account.status to SESSION_EXPIRED.
//   * `ScrapeFailedError` thrown for everything else that goes wrong inside
//     this module. Processor surfaces the message in Run.errorMessage.
//
// Robustness notes:
//   * The default URLs are `https://www.tokopedia.com/order-list?status=dibayar`
//     (paid) and `https://www.tokopedia.com/order-list?status=dikirim`
//     (shipped). PRD §7.4.1 / §7.4.2 / §18 OQ#1 explicitly call this out as
//     needing live verification — Tokopedia changes URLs from time to time.
//     The `paidUrlOverride` / `shippedUrlOverride` fields on Account exist
//     precisely so an operator can fix a URL drift without a code change.
//   * Per-order detail-page screenshots are TODO for both passes. For now
//     we capture ONE full-page screenshot of the list view per run and
//     reuse its path for every order's `screenshotPath`. PRD §7.4 only
//     requires that we attach proof; the per-order detail screenshot is a
//     nicety we defer to a later round (post-C3b) once Stagehand's
//     act/observe loops are exercised against the real site.
//   * Currency in IDR is rendered as `Rp 50.000` (or `Rp50.000`); we strip
//     non-digits and parse to integer rupiah (contract §3.5).
//   * Order date appears as `29 Apr 2026` etc. We map Indonesian month
//     abbreviations / full names to month numbers and emit
//     `YYYY-MM-DD` strings the InvenFlow ingest endpoint accepts (§4.6).

import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import type { Stagehand } from '@browserbasehq/stagehand';
import { z } from 'zod';

import { getActiveAiSettings } from '../lib/ai-config.js';
import { childLogger } from '../lib/logger.js';

const log = childLogger('agent:tokopedia');

// -----------------------------------------------------------------------------
// Public types
// -----------------------------------------------------------------------------

export interface ScrapedLineItem {
  marketplaceProductName: string;
  marketplaceProductUrl: string | null;
  /** Integer count of units (>= 1). */
  quantity: number;
  /** Integer rupiah, no decimals. */
  unitPrice: number;
  /** Integer rupiah, no decimals. Should equal quantity * unitPrice. */
  subtotal: number;
}

export interface ScrapedOrder {
  /** Tokopedia invoice number, e.g. `INV/20260429/XX/IV/123456`. */
  invoiceNumber: string;
  /** ISO 8601 date (`YYYY-MM-DD`) — orderDate accepted by InvenFlow §4.6. */
  orderDate: string;
  sellerName: string | null;
  lineItems: ScrapedLineItem[];
  /** Integer rupiah; `null` if shipping is bundled / not shown. */
  shippingFee: number | null;
  /** Integer rupiah discount (positive number); `null` if no discount. */
  discount: number | null;
  /** Integer rupiah grand total. */
  totalAmount: number;
  /** URL to the per-order detail page if the agent could find one. */
  detailUrl: string | null;
  /**
   * Absolute filesystem path of a screenshot proving this order's state at
   * scrape time. Processor reads the file, uploads to InvenFlow, and then
   * cleans up the directory. May be reused across orders if the agent
   * captured a single list-view screenshot (see file header).
   */
  screenshotPath: string;
}

export interface ScrapePaidOptions {
  accountId: string;
  runId: string;
  paidUrlOverride?: string | null;
  /** Where to write per-order screenshots; processor passes /tmp/screenshots/<runId>. */
  screenshotDir: string;
}

export interface ScrapePaidResult {
  orders: ScrapedOrder[];
  /** AI model name as recorded against `Run.modelUsed` (PRD §11.4). */
  modelUsed: string;
}

// -----------------------------------------------------------------------------
// Errors
// -----------------------------------------------------------------------------

/**
 * Raised when navigation lands on a login page (Tokopedia bounces an
 * unauthenticated request to `/login`). The processor catches this and
 * marks `Account.status = SESSION_EXPIRED`; no retry happens — the operator
 * must re-login via the interactive browser session (PRD §7.3.2).
 */
export class SessionExpiredError extends Error {
  readonly currentUrl: string;
  constructor(currentUrl: string) {
    super(
      `Tokopedia session expired — page redirected to login: ${currentUrl}`,
    );
    this.name = 'SessionExpiredError';
    this.currentUrl = currentUrl;
  }
}

/**
 * Generic wrapper around any other failure inside the scrape. The original
 * error message is attached so the processor can surface it as
 * `Run.errorMessage`. Network errors, Stagehand extraction errors, file IO
 * errors, etc. all flow through this type.
 */
export class ScrapeFailedError extends Error {
  readonly cause: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'ScrapeFailedError';
    this.cause = cause;
  }
}

// -----------------------------------------------------------------------------
// Constants — defaults and known signals
// -----------------------------------------------------------------------------

/**
 * Default paid-orders URL.
 *
 * PRD §7.4.1 / §18 OQ#1: this URL needs live verification. Operators can
 * override it per-account via `Account.paidUrlOverride`.
 */
const DEFAULT_PAID_URL = 'https://www.tokopedia.com/order-list?status=dibayar';

/** Substrings that, when present in the navigated URL, indicate a redirect
 *  to login (session expired). */
const LOGIN_URL_SIGNALS = ['/login', 'tokopedia.com/login', 'sso/login'] as const;

const NAV_TIMEOUT_MS = 60_000;

// -----------------------------------------------------------------------------
// Zod schema for Stagehand extract()
// -----------------------------------------------------------------------------

/**
 * Schema describing the extraction shape we ask Stagehand for. Using
 * `nullable()` rather than `optional()` because Stagehand's strict-mode
 * extraction sometimes fills missing fields with `null`. The instruction
 * string below tells the model to do exactly that.
 *
 * NOTE: prices and quantities come back as strings here (raw text from the
 * page); we coerce after extraction so we control rupiah parsing and date
 * normalization explicitly rather than relying on the LLM's number sense.
 */
const RawLineItemSchema = z.object({
  marketplaceProductName: z.string(),
  marketplaceProductUrl: z.string().nullable(),
  quantity: z.string(),
  unitPriceText: z.string(),
  subtotalText: z.string(),
});

const RawOrderSchema = z.object({
  invoiceNumber: z.string(),
  orderDateText: z.string(),
  sellerName: z.string().nullable(),
  lineItems: z.array(RawLineItemSchema),
  shippingFeeText: z.string().nullable(),
  discountText: z.string().nullable(),
  totalAmountText: z.string(),
  detailUrl: z.string().nullable(),
});

const ExtractSchema = z.object({
  orders: z.array(RawOrderSchema),
});

type RawOrder = z.infer<typeof RawOrderSchema>;

// -----------------------------------------------------------------------------
// Public entry point
// -----------------------------------------------------------------------------

/**
 * Stagehand instruction text for the paid-orders extraction. Lifted into a
 * named constant so the processor / tests can log it and so the literal
 * matches what the report describes.
 */
const EXTRACT_INSTRUCTION = [
  'Extract every visible order on this page.',
  'Each order has an invoice number, an order date, a seller name (the shop name),',
  'a list of products (with marketplace product name, product URL if shown, quantity,',
  'unit price as text, subtotal as text), an optional shipping fee text, an optional',
  'discount text, a total amount text, and an optional detail URL pointing to the',
  '"Lihat Detail Transaksi" / order-detail page. Return prices and totals as the raw',
  'visible text including the "Rp" prefix and any thousand separators (e.g. "Rp 50.000").',
  'Return the order date as the raw visible text (e.g. "29 Apr 2026").',
  'When a field is not present on the page, set it to null. Return an array of orders.',
].join(' ');

export async function scrapePaid(
  stagehand: Stagehand,
  options: ScrapePaidOptions,
): Promise<ScrapePaidResult> {
  const { accountId, runId, paidUrlOverride, screenshotDir } = options;
  const url =
    paidUrlOverride && paidUrlOverride.length > 0
      ? paidUrlOverride
      : DEFAULT_PAID_URL;

  // Read the active model name once so we can record it on Run.modelUsed.
  let modelUsed: string;
  try {
    const ai = await getActiveAiSettings();
    modelUsed = ai.model;
  } catch (err) {
    throw new ScrapeFailedError(
      `Could not load active AI settings before scrape: ${(err as Error).message}`,
      err,
    );
  }

  log.info({ accountId, runId, url, modelUsed }, 'scrape-paid: starting');

  // 1. Navigate
  const page = stagehand.page;
  try {
    await page.goto(url, {
      waitUntil: 'networkidle',
      timeout: NAV_TIMEOUT_MS,
    });
  } catch (err) {
    throw new ScrapeFailedError(
      `Failed to navigate to ${url}: ${(err as Error).message}`,
      err,
    );
  }

  // 2. Sanity check — did we land on the login page?
  const landedUrl = page.url();
  if (
    LOGIN_URL_SIGNALS.some((signal) => landedUrl.includes(signal))
  ) {
    log.warn({ accountId, runId, landedUrl }, 'scrape-paid: redirected to login');
    throw new SessionExpiredError(landedUrl);
  }

  // 3. Capture a list-view screenshot. Used as the proof artifact for every
  //    order on this run (see file header — per-order detail screenshots
  //    are TODO).
  await mkdir(screenshotDir, { recursive: true });
  const listScreenshotPath = path.join(screenshotDir, `${runId}-list.png`);
  try {
    await page.screenshot({
      path: listScreenshotPath,
      fullPage: true,
      type: 'png',
    });
  } catch (err) {
    throw new ScrapeFailedError(
      `Failed to capture list-view screenshot: ${(err as Error).message}`,
      err,
    );
  }

  // 4. Extract orders via Stagehand. Wrapped in try/catch so any extraction
  //    failure flows through ScrapeFailedError.
  let extracted: z.infer<typeof ExtractSchema>;
  try {
    extracted = await page.extract({
      instruction: EXTRACT_INSTRUCTION,
      schema: ExtractSchema,
    });
  } catch (err) {
    throw new ScrapeFailedError(
      `Stagehand extract() failed: ${(err as Error).message}`,
      err,
    );
  }

  log.info(
    { accountId, runId, orderCount: extracted.orders.length },
    'scrape-paid: extraction complete',
  );

  // 5. Coerce raw text fields → typed `ScrapedOrder`s. Skip orders that fail
  //    to parse rather than aborting the whole run; bad rows are logged.
  const orders: ScrapedOrder[] = [];
  for (const raw of extracted.orders) {
    try {
      orders.push(coerceOrder(raw, listScreenshotPath));
    } catch (err) {
      log.warn(
        {
          accountId,
          runId,
          invoiceNumber: raw.invoiceNumber,
          err: (err as Error).message,
        },
        'scrape-paid: skipping unparseable order',
      );
    }
  }

  return { orders, modelUsed };
}

// -----------------------------------------------------------------------------
// Coercion helpers
// -----------------------------------------------------------------------------

/**
 * Strips non-digits and returns an integer count of rupiah. Returns 0 for
 * empty / falsy input so optional fields (shippingFee, discount) coerce to
 * null cleanly via the wrapping helper.
 */
export function parseRupiah(s: string): number {
  if (typeof s !== 'string') return 0;
  // Strip everything that isn't a digit or a leading minus sign.
  const cleaned = s.replace(/[^\d-]/g, '');
  if (cleaned.length === 0) return 0;
  const n = Number.parseInt(cleaned, 10);
  if (!Number.isFinite(n)) return 0;
  return n;
}

/** Returns parseRupiah(s) if the string is non-empty after trimming, else null. */
function parseRupiahOrNull(s: string | null): number | null {
  if (s == null) return null;
  const trimmed = s.trim();
  if (trimmed.length === 0) return null;
  // Treat explicit "0" / "Rp 0" as a real zero, not null.
  return parseRupiah(trimmed);
}

/** Maps Indonesian month abbreviations + full names to month numbers (1–12). */
const ID_MONTHS: Record<string, number> = {
  jan: 1, januari: 1,
  feb: 2, februari: 2,
  mar: 3, maret: 3,
  apr: 4, april: 4,
  mei: 5,
  jun: 6, juni: 6,
  jul: 7, juli: 7,
  agu: 8, agt: 8, agustus: 8, aug: 8,
  sep: 9, september: 9, sept: 9,
  okt: 10, oktober: 10, oct: 10,
  nov: 11, november: 11,
  des: 12, desember: 12, dec: 12,
};

/**
 * Parses Indonesian-formatted dates like `29 Apr 2026` / `29 April 2026`
 * into an ISO `YYYY-MM-DD` string. Falls through to native Date parsing if
 * the input doesn't match the expected `D MMM YYYY` shape.
 */
export function parseTokopediaDate(s: string): string {
  const trimmed = s.trim();

  // Try the explicit `D MMM YYYY` pattern first.
  const m = trimmed.match(/^(\d{1,2})\s+([A-Za-z\.]+)\s+(\d{4})$/);
  if (m && m[1] && m[2] && m[3]) {
    const day = Number.parseInt(m[1], 10);
    const monthKey = m[2].toLowerCase().replace(/\.+$/, '');
    const year = Number.parseInt(m[3], 10);
    const month = ID_MONTHS[monthKey];
    if (month && Number.isFinite(day) && Number.isFinite(year)) {
      return `${year.toString().padStart(4, '0')}-${month
        .toString()
        .padStart(2, '0')}-${day.toString().padStart(2, '0')}`;
    }
  }

  // Fall back to native Date parsing — handles ISO strings, RFC 2822, etc.
  const d = new Date(trimmed);
  if (Number.isFinite(d.getTime())) {
    const year = d.getUTCFullYear();
    const month = d.getUTCMonth() + 1;
    const day = d.getUTCDate();
    return `${year.toString().padStart(4, '0')}-${month
      .toString()
      .padStart(2, '0')}-${day.toString().padStart(2, '0')}`;
  }

  throw new Error(`Could not parse Tokopedia date string: ${JSON.stringify(s)}`);
}

function coerceOrder(raw: RawOrder, screenshotPath: string): ScrapedOrder {
  if (!raw.invoiceNumber || raw.invoiceNumber.trim().length === 0) {
    throw new Error('order is missing invoiceNumber');
  }

  const orderDate = parseTokopediaDate(raw.orderDateText);

  const lineItems: ScrapedLineItem[] = raw.lineItems.map((li, idx) => {
    const quantity = Number.parseInt(li.quantity.replace(/[^\d-]/g, ''), 10);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw new Error(
        `line item #${idx} of ${raw.invoiceNumber} has invalid quantity: ${JSON.stringify(li.quantity)}`,
      );
    }
    const unitPrice = parseRupiah(li.unitPriceText);
    const subtotal = parseRupiah(li.subtotalText);
    return {
      marketplaceProductName: li.marketplaceProductName,
      marketplaceProductUrl: li.marketplaceProductUrl,
      quantity,
      unitPrice,
      subtotal,
    };
  });

  return {
    invoiceNumber: raw.invoiceNumber.trim(),
    orderDate,
    sellerName: raw.sellerName,
    lineItems,
    shippingFee: parseRupiahOrNull(raw.shippingFeeText),
    discount: parseRupiahOrNull(raw.discountText),
    totalAmount: parseRupiah(raw.totalAmountText),
    detailUrl: raw.detailUrl,
    screenshotPath,
  };
}

// -----------------------------------------------------------------------------
// PASS B — Shipped (`dikirim`) scrape (C3b)
//
// Lighter schema than the paid pass — we only need `{ invoiceNumber,
// detailUrl }` per order to drive the transition engine. The local DB
// already has product/qty/price from the paid ingest; the shipped pass just
// flips the lifecycle state and moves the kanban card.
// -----------------------------------------------------------------------------

export interface ShippedOrder {
  invoiceNumber: string;
  detailUrl: string | null;
  /**
   * Path to a single proof screenshot (full-page list, or per-order
   * detail). Strategy mirrors paid: one full-page list screenshot reused
   * per order is acceptable for v1.
   */
  screenshotPath: string;
}

export interface ScrapeShippedOptions {
  accountId: string;
  runId: string;
  shippedUrlOverride?: string | null;
  /** Where to write the list-view screenshot; processor passes /tmp/screenshots/<runId>. */
  screenshotDir: string;
}

export interface ScrapeShippedResult {
  orders: ShippedOrder[];
  /** AI model name as recorded against `Run.modelUsed` (PRD §11.4). */
  modelUsed: string;
}

/**
 * Default shipped-orders URL.
 *
 * PRD §7.4.2 / §18 OQ#1: this URL needs live verification. Operators can
 * override it per-account via `Account.shippedUrlOverride`. Mirrors the
 * paid-pass URL strategy (single source-of-truth string here, override per
 * account in the DB).
 */
const DEFAULT_SHIPPED_URL =
  'https://www.tokopedia.com/order-list?status=dikirim';

/**
 * Stagehand instruction string for the shipped extraction. Lifted into a
 * named constant so the processor / tests can log it and the report
 * matches the literal sent to the model.
 */
const SHIPPED_EXTRACT_INSTRUCTION = [
  'List every visible shipped order on this page.',
  'For each order, extract the invoice number',
  "(often shown as 'INV/...' or similar) and the URL to its detail / tracking",
  'page if a link is present.',
  'Set fields not visible to null.',
].join(' ');

const RawShippedOrderSchema = z.object({
  invoiceNumber: z.string(),
  detailUrl: z.string().nullable().optional(),
});

const ShippedExtractSchema = z.object({
  orders: z.array(RawShippedOrderSchema),
});

export async function scrapeShipped(
  stagehand: Stagehand,
  options: ScrapeShippedOptions,
): Promise<ScrapeShippedResult> {
  const { accountId, runId, shippedUrlOverride, screenshotDir } = options;
  const url =
    shippedUrlOverride && shippedUrlOverride.length > 0
      ? shippedUrlOverride
      : DEFAULT_SHIPPED_URL;

  // Read the active model name once so we can record it on Run.modelUsed.
  let modelUsed: string;
  try {
    const ai = await getActiveAiSettings();
    modelUsed = ai.model;
  } catch (err) {
    throw new ScrapeFailedError(
      `Could not load active AI settings before scrape: ${(err as Error).message}`,
      err,
    );
  }

  log.info({ accountId, runId, url, modelUsed }, 'scrape-shipped: starting');

  // 1. Navigate.
  const page = stagehand.page;
  try {
    await page.goto(url, {
      waitUntil: 'networkidle',
      timeout: NAV_TIMEOUT_MS,
    });
  } catch (err) {
    throw new ScrapeFailedError(
      `Failed to navigate to ${url}: ${(err as Error).message}`,
      err,
    );
  }

  // 2. Login-redirect detection — same signals as the paid pass.
  const landedUrl = page.url();
  if (LOGIN_URL_SIGNALS.some((signal) => landedUrl.includes(signal))) {
    log.warn(
      { accountId, runId, landedUrl },
      'scrape-shipped: redirected to login',
    );
    throw new SessionExpiredError(landedUrl);
  }

  // 3. Capture a list-view screenshot. Used as the proof artifact for every
  //    transition on this run (per-order detail screenshots are deferred —
  //    see file header).
  await mkdir(screenshotDir, { recursive: true });
  const listScreenshotPath = path.join(
    screenshotDir,
    `${runId}-shipped-list.png`,
  );
  try {
    await page.screenshot({
      path: listScreenshotPath,
      fullPage: true,
      type: 'png',
    });
  } catch (err) {
    throw new ScrapeFailedError(
      `Failed to capture list-view screenshot: ${(err as Error).message}`,
      err,
    );
  }

  // 4. Extract orders via Stagehand.
  let extracted: z.infer<typeof ShippedExtractSchema>;
  try {
    extracted = await page.extract({
      instruction: SHIPPED_EXTRACT_INSTRUCTION,
      schema: ShippedExtractSchema,
    });
  } catch (err) {
    throw new ScrapeFailedError(
      `Stagehand extract() failed: ${(err as Error).message}`,
      err,
    );
  }

  log.info(
    { accountId, runId, orderCount: extracted.orders.length },
    'scrape-shipped: extraction complete',
  );

  // 5. Coerce — drop rows with no invoice number; everything else is light
  //    enough to pass through directly.
  const orders: ShippedOrder[] = [];
  for (const raw of extracted.orders) {
    const invoiceNumber = (raw.invoiceNumber ?? '').trim();
    if (invoiceNumber.length === 0) {
      log.warn(
        { accountId, runId, raw },
        'scrape-shipped: skipping order with empty invoice number',
      );
      continue;
    }
    orders.push({
      invoiceNumber,
      detailUrl: raw.detailUrl ?? null,
      screenshotPath: listScreenshotPath,
    });
  }

  return { orders, modelUsed };
}

// Exposed for tests.
export const __testing = {
  coerceOrder,
  EXTRACT_INSTRUCTION,
  SHIPPED_EXTRACT_INSTRUCTION,
};

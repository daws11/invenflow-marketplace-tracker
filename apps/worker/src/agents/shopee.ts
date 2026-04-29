// Shopee agent — paid + shipped scrapes (PRD §7.4.1 / §7.4.2).
//
// Mirrors the Tokopedia agent (apps/worker/src/agents/tokopedia.ts) — same
// public contract, same two-pass model (paid + shipped). The Stagehand
// instance is constructed by the caller via `apps/worker/src/browser/
// factory.ts`, which already accepts `platform: 'shopee'` and applies the
// same anti-detection args + AI config.
//
// Shared (with Tokopedia) bits live in `_common.ts`:
//   * IDR rupiah parsing (`parseRupiah`, `parseRupiahOrNull`)
//   * `SessionExpiredError`, `ScrapeFailedError`
//   * `ScrapedOrder` / `ScrapedLineItem` / `ShippedOrder` types
//   * `NAV_TIMEOUT_MS`
//
// Shopee-specific bits live HERE:
//   * Default URLs (`?type=2` paid / `?type=3` shipped — see assumption below).
//   * Login-redirect signals (`/buyer/login`, `login_signup`, `/sso/login`).
//   * `parseShopeeDate` — handles both `2026-04-30 15:30` and the localized
//     `30 April 2026` (Indonesian full-month-name) form.
//   * Stagehand `extract()` instruction strings tailored to Shopee's UI
//     vocabulary ("Order ID" / "No. Pesanan", different "view detail" labels).
//
// URL ASSUMPTIONS (PRD §18 OQ#1 — needs verification against a live Shopee
// buyer account):
//   * Paid (to_ship)         : https://shopee.co.id/user/purchase?type=2
//   * Shipped (to_receive)   : https://shopee.co.id/user/purchase?type=3
//
// These follow Shopee's common `?type=N` filter convention. If real-account
// verification shows a different number, operators can drop a custom URL
// into `Account.paidUrlOverride` / `Account.shippedUrlOverride` without a
// code change — the same escape hatch we use for Tokopedia.
//
// Login-redirect signals are likewise a reasonable guess (Shopee's mobile
// flow uses `/buyer/login`; SSO and `login_signup` cover the desktop flow).
// All three need verification with a real session-expired browser to make
// sure we trip `SessionExpiredError` correctly.
//
// v1 screenshot strategy is identical to Tokopedia: ONE full-page list-view
// screenshot per run, path reused as every order's `screenshotPath`. Per-
// order detail-page screenshots are TODO and gated on Stagehand's act/
// observe loops being exercised against real Shopee pages.

import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import type { Stagehand } from '@browserbasehq/stagehand';
import { z } from 'zod';

import { getActiveAiSettings } from '../lib/ai-config.js';
import { childLogger } from '../lib/logger.js';
import {
  NAV_TIMEOUT_MS,
  parseRupiah,
  parseRupiahOrNull,
  ScrapeFailedError,
  SessionExpiredError,
  type ScrapedLineItem,
  type ScrapedOrder,
  type ScrapePaidOptions,
  type ScrapePaidResult,
  type ScrapeShippedOptions,
  type ScrapeShippedResult,
  type ShippedOrder,
} from './_common.js';

const log = childLogger('agent:shopee');

// -----------------------------------------------------------------------------
// Re-exports — keep the public surface symmetric with `tokopedia.ts` so the
// processors can import platform-agnostically when convenient.
// -----------------------------------------------------------------------------

export {
  ScrapeFailedError,
  SessionExpiredError,
  parseRupiah,
} from './_common.js';
export type {
  ScrapedLineItem,
  ScrapedOrder,
  ScrapePaidOptions,
  ScrapePaidResult,
  ScrapeShippedOptions,
  ScrapeShippedResult,
  ShippedOrder,
} from './_common.js';

// -----------------------------------------------------------------------------
// Shopee-specific constants
// -----------------------------------------------------------------------------

/**
 * Default Shopee paid-orders (to-ship) URL.
 *
 * ASSUMPTION (PRD §18 OQ#1, §7.4.1): Shopee's "to ship / waiting for seller"
 * tab is reachable at `?type=2` on the buyer purchase list. Verified against
 * Shopee documentation patterns; needs final confirmation against a live
 * buyer account. Operators can override per-account via
 * `Account.paidUrlOverride` if Shopee shifts the filter index.
 */
const DEFAULT_PAID_URL = 'https://shopee.co.id/user/purchase?type=2';

/**
 * Default Shopee shipped-orders (to-receive / in-transit) URL.
 *
 * ASSUMPTION (PRD §18 OQ#1, §7.4.2): Shopee's "shipped / to receive" tab is
 * reachable at `?type=3`. Same verification caveat as the paid URL above —
 * operators can override per-account via `Account.shippedUrlOverride`.
 */
const DEFAULT_SHIPPED_URL = 'https://shopee.co.id/user/purchase?type=3';

/**
 * Substrings that, when present in the navigated URL, indicate a redirect
 * to a Shopee login flow (session expired). Best-effort guess covering the
 * common variants:
 *   * `/buyer/login`              — desktop buyer login
 *   * `shopee.co.id/buyer/login`  — fully-qualified variant of the above
 *   * `login_signup`              — Shopee's path-segment form for signin
 *   * `/sso/login`                — single-sign-on bounce page
 *
 * Needs verification against a real session-expired browser; if Shopee's
 * actual redirect target lands somewhere else, add the substring here.
 */
const SHOPEE_LOGIN_URL_SIGNALS = [
  '/buyer/login',
  'shopee.co.id/buyer/login',
  'login_signup',
  '/sso/login',
] as const;

// -----------------------------------------------------------------------------
// Zod schema for Stagehand extract() — paid pass
// -----------------------------------------------------------------------------

/**
 * Schema describing the extraction shape we ask Stagehand for. Mirror of the
 * Tokopedia version: prices/dates come back as raw text so we can apply
 * deterministic Shopee-specific parsers.
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

/**
 * Stagehand instruction text for the paid-orders extraction. Tailored to
 * Shopee's UI vocabulary — Shopee labels the invoice as "Order ID" or
 * "No. Pesanan", prices show with a `Rp` prefix and dot thousand separators
 * (e.g. `Rp50.000`), and order dates may appear either as
 * `2026-04-30 15:30` (ISO-like) or `30 April 2026` (full Indonesian month
 * name). The model returns raw text so we can parse deterministically
 * regardless of which date form Shopee currently renders.
 */
const EXTRACT_INSTRUCTION = [
  'Extract every visible order on this page (Shopee buyer purchase list).',
  'Each order has an invoice number — Shopee labels it as "Order ID" or',
  '"No. Pesanan" depending on the locale; capture whichever string identifies',
  'the order. Each order also has an order date, a seller name (the shop name),',
  'a list of products (with marketplace product name, product URL if shown,',
  'quantity, unit price as text, subtotal as text), an optional shipping fee',
  'text, an optional discount text, a total amount text, and an optional',
  'detail URL pointing to the order-detail page if a link is present.',
  'Return prices and totals as the raw visible text including the "Rp" prefix',
  'and dot thousand separators (e.g. "Rp50.000" or "Rp 50.000").',
  'Return the order date as the raw visible text — Shopee may render it as',
  '"2026-04-30 15:30" (ISO-like) or "30 April 2026" (full Indonesian month',
  'name). Do not try to reformat — return exactly what is shown.',
  'When a field is not present on the page, set it to null. Return an array',
  'of orders.',
].join(' ');

// -----------------------------------------------------------------------------
// Public entry point — paid (to-ship) pass
// -----------------------------------------------------------------------------

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

  // 2. Sanity check — did we land on the login page?
  const landedUrl = page.url();
  if (SHOPEE_LOGIN_URL_SIGNALS.some((signal) => landedUrl.includes(signal))) {
    log.warn({ accountId, runId, landedUrl }, 'scrape-paid: redirected to login');
    throw new SessionExpiredError(landedUrl);
  }

  // 3. Capture a list-view screenshot. Used as the proof artifact for every
  //    order on this run (per-order detail screenshots are TODO — see file
  //    header).
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

/** Maps Indonesian full month names to month numbers (1–12). Shopee uses the
 *  full localized form (`Januari`, `Februari`, …) more often than the
 *  abbreviated form. We lowercase the captured token before lookup. */
const ID_FULL_MONTHS: Record<string, number> = {
  januari: 1,
  februari: 2,
  maret: 3,
  april: 4,
  mei: 5,
  juni: 6,
  juli: 7,
  agustus: 8,
  september: 9,
  oktober: 10,
  november: 11,
  desember: 12,
};

/**
 * Parses Shopee-formatted dates into an ISO `YYYY-MM-DD` string (UTC).
 *
 * Two-step strategy:
 *   1. Try `new Date(s)` directly — handles ISO and ISO-like forms
 *      (`2026-04-30T15:30:00`, `2026-04-30 15:30`).
 *   2. Fall back to a regex match against `^(\d{1,2}) ([A-Za-z]+) (\d{4})$`
 *      with the Indonesian full-month map (`30 April 2026`).
 *
 * Throws if neither path yields a finite date.
 */
export function parseShopeeDate(s: string): string {
  const trimmed = s.trim();

  // Step 1: native Date parse — handles ISO, ISO-like, RFC 2822, etc. Note
  // that Date interprets `YYYY-MM-DD HH:mm` as local time on most engines,
  // which is fine for our day-precision output.
  const direct = new Date(trimmed);
  if (Number.isFinite(direct.getTime())) {
    return formatYmdUtc(direct);
  }

  // Step 2: localized fallback — `30 April 2026`.
  const m = trimmed.match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/);
  if (m && m[1] && m[2] && m[3]) {
    const day = Number.parseInt(m[1], 10);
    const monthKey = m[2].toLowerCase();
    const year = Number.parseInt(m[3], 10);
    const month = ID_FULL_MONTHS[monthKey];
    if (month && Number.isFinite(day) && Number.isFinite(year)) {
      return `${year.toString().padStart(4, '0')}-${month
        .toString()
        .padStart(2, '0')}-${day.toString().padStart(2, '0')}`;
    }
  }

  throw new Error(`Could not parse Shopee date string: ${JSON.stringify(s)}`);
}

/** Format a Date into `YYYY-MM-DD` using its UTC components. */
function formatYmdUtc(d: Date): string {
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  return `${year.toString().padStart(4, '0')}-${month
    .toString()
    .padStart(2, '0')}-${day.toString().padStart(2, '0')}`;
}

function coerceOrder(raw: RawOrder, screenshotPath: string): ScrapedOrder {
  if (!raw.invoiceNumber || raw.invoiceNumber.trim().length === 0) {
    throw new Error('order is missing invoiceNumber');
  }

  const orderDate = parseShopeeDate(raw.orderDateText);

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
// PASS B — Shipped (to-receive / in-transit) scrape
//
// Lighter schema than the paid pass — we only need `{ invoiceNumber,
// detailUrl }` per order to drive the transition engine. The local DB
// already has product/qty/price from the paid ingest; the shipped pass just
// flips the lifecycle state and moves the kanban card.
// -----------------------------------------------------------------------------

/**
 * Stagehand instruction string for the shipped extraction. Tailored to
 * Shopee's UI vocabulary — Shopee labels the invoice as "Order ID" or
 * "No. Pesanan"; the detail link is typically labelled "View Order Details"
 * or "Lihat Detail Pesanan".
 */
const SHIPPED_EXTRACT_INSTRUCTION = [
  'List every visible shipped order on this page (Shopee buyer "to receive"',
  'or "in transit" tab). For each order, extract the invoice number — Shopee',
  'labels it as "Order ID" or "No. Pesanan" depending on the locale; capture',
  'whichever string identifies the order. Also extract the URL to its detail',
  '/ tracking page if a link is present (Shopee usually labels it as "View',
  'Order Details" or "Lihat Detail Pesanan"). Return prices and dates as raw',
  'text if any are present. Set fields not visible to null.',
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
  if (SHOPEE_LOGIN_URL_SIGNALS.some((signal) => landedUrl.includes(signal))) {
    log.warn(
      { accountId, runId, landedUrl },
      'scrape-shipped: redirected to login',
    );
    throw new SessionExpiredError(landedUrl);
  }

  // 3. Capture a list-view screenshot. Used as the proof artifact for every
  //    transition on this run (per-order detail screenshots are TODO — see
  //    file header).
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
  parseShopeeDate,
  EXTRACT_INSTRUCTION,
  SHIPPED_EXTRACT_INSTRUCTION,
  SHOPEE_LOGIN_URL_SIGNALS,
  DEFAULT_PAID_URL,
  DEFAULT_SHIPPED_URL,
};

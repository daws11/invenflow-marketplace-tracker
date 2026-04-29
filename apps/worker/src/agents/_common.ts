// Shared marketplace-agent helpers — Tokopedia + Shopee (PRD §7.4).
//
// Two-platform sharing strategy: keep the platform-agnostic pieces here
// (rupiah parsing, shared error types, the `ScrapedOrder` / `ShippedOrder`
// schemas, navigation timeout) so the per-platform files (`tokopedia.ts`,
// `shopee.ts`) only differ where they MUST differ — URLs, login-redirect
// signals, locale-specific date parsing, and the Stagehand `extract()`
// instruction strings tailored to each marketplace's UI vocabulary.
//
// What lives HERE:
//   * `parseRupiah` / `parseRupiahOrNull` — IDR is the same on both
//     platforms; both render `Rp 50.000` style strings.
//   * `SessionExpiredError` — thrown by either agent when navigation lands
//     on a platform login URL. Processor catches and flips
//     Account.status = SESSION_EXPIRED (PRD §7.3.2).
//   * `ScrapeFailedError` — generic wrapper for any other agent failure.
//   * Shared types: `ScrapedLineItem`, `ScrapedOrder`, `ShippedOrder`,
//     `ScrapePaidOptions`, `ScrapeShippedOptions`, `ScrapePaidResult`,
//     `ScrapeShippedResult`. Both agents return these exact shapes; the
//     processors are platform-agnostic from here on.
//   * `NAV_TIMEOUT_MS` — Playwright `goto()` / Stagehand `extract()`
//     navigation timeout. Same on both platforms.
//
// What stays in the per-platform files:
//   * `DEFAULT_PAID_URL` / `DEFAULT_SHIPPED_URL` — different URL shapes.
//   * `LOGIN_URL_SIGNALS` — different login redirect signals.
//   * `parseTokopediaDate` / `parseShopeeDate` — different locale formats
//     (`29 Apr 2026` vs. `2026-04-30 15:30` / `30 April 2026`).
//   * `EXTRACT_INSTRUCTION` / `SHIPPED_EXTRACT_INSTRUCTION` — different UI
//     vocabulary ("Lihat Detail Transaksi" vs. "Order ID" / "No. Pesanan").
//
// v1 screenshot strategy (per PRD §7.4): single full-page list-view
// screenshot per run, reused as `screenshotPath` for every order. Per-order
// detail-page screenshots are deferred to a later round once the act/observe
// loops are exercised against real sites. This applies to BOTH platforms.

// -----------------------------------------------------------------------------
// Shared types — used by tokopedia.ts and shopee.ts; kept verbatim so the
// processors can dispatch by platform without per-shape adapter code.
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
  /** Marketplace invoice number, e.g. `INV/20260429/XX/IV/123456` (Tokopedia)
   *  or a Shopee Order ID. */
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

// -----------------------------------------------------------------------------
// Shared errors
// -----------------------------------------------------------------------------

/**
 * Raised when navigation lands on a login page (the marketplace bounces an
 * unauthenticated request to its `/login` flow). The processor catches this
 * and marks `Account.status = SESSION_EXPIRED`; no retry happens — the
 * operator must re-login via the interactive browser session (PRD §7.3.2).
 *
 * The error message is constructed without a platform prefix so the same
 * class can be thrown from any agent. The original `currentUrl` is included
 * for debugging (it tells the operator which login page the redirect went
 * to: Tokopedia, Shopee /buyer/login, sso/login, etc.).
 */
export class SessionExpiredError extends Error {
  readonly currentUrl: string;
  constructor(currentUrl: string) {
    super(`Marketplace session expired — page redirected to login: ${currentUrl}`);
    this.name = 'SessionExpiredError';
    this.currentUrl = currentUrl;
  }
}

/**
 * Generic wrapper around any other failure inside a scrape. The original
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
// Shared constants
// -----------------------------------------------------------------------------

/**
 * Playwright/Stagehand navigation + extraction timeout. Same for both
 * platforms — both can be slow to render their order-list pages on cold
 * cache, and 60s is the common upper bound observed in practice.
 */
export const NAV_TIMEOUT_MS = 60_000;

// -----------------------------------------------------------------------------
// Shared parsers — IDR rupiah amounts render the same on both platforms
// (`Rp 50.000`, `Rp50.000`, with dot thousand separators).
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
export function parseRupiahOrNull(s: string | null | undefined): number | null {
  if (s == null) return null;
  const trimmed = s.trim();
  if (trimmed.length === 0) return null;
  // Treat explicit "0" / "Rp 0" as a real zero, not null.
  return parseRupiah(trimmed);
}

// Shared parsing helpers for the content-script world. Loaded *before* the
// per-platform parsers and bridge.js (see the manifest content_scripts order),
// so it just hangs everything off a single namespace object that they share.
//
// All of this runs in the content-script isolated world — it cannot touch the
// page's own globals, and the page cannot see ours.
(() => {
  const NS = (globalThis.__ifScraper = globalThis.__ifScraper || {});

  /** "Rp 1.234.567" / "Rp1.234.567,-" / 1234567 -> 1234567 (integer >= 0). */
  NS.parseRupiah = function parseRupiah(value) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return Math.max(0, Math.round(value));
    }
    if (typeof value !== 'string') return 0;
    // Drop a trailing ",dd" decimal chunk if present, then keep digits + '-'.
    const noDecimals = value.replace(/,\d{1,2}\s*$/, '');
    const cleaned = noDecimals.replace(/[^\d-]/g, '');
    if (!cleaned) return 0;
    const n = Number.parseInt(cleaned, 10);
    return Number.isFinite(n) ? Math.max(0, n) : 0;
  };

  NS.parseRupiahOrNull = function parseRupiahOrNull(value) {
    if (value == null) return null;
    if (typeof value === 'string' && value.trim() === '') return null;
    return NS.parseRupiah(value);
  };

  const MONTHS_ID = {
    jan: 1, feb: 2, mar: 3, apr: 4, mei: 5, jun: 6, jul: 7, agt: 8,
    agu: 8, ags: 8, sep: 9, okt: 10, nov: 11, des: 12,
    januari: 1, februari: 2, maret: 3, april: 4, juni: 6, juli: 7,
    agustus: 8, september: 9, oktober: 10, november: 11, desember: 12,
  };

  function pad(n) {
    return String(n).padStart(2, '0');
  }
  function fmt(d) {
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  /**
   * Best-effort parse of a date into `YYYY-MM-DD` (local). Accepts epoch
   * seconds/millis (number or numeric string), ISO-ish strings
   * ("2026-04-30 15:30"), and Indonesian "30 April 2026" / "30 Apr 2026".
   * Returns null when nothing parses.
   */
  NS.toISODate = function toISODate(input) {
    if (input == null) return null;
    const asNum = typeof input === 'number' ? input : (/^\d{9,13}$/.test(String(input).trim()) ? Number(input) : NaN);
    if (Number.isFinite(asNum)) {
      const ms = asNum < 1e12 ? asNum * 1000 : asNum;
      const d = new Date(ms);
      return Number.isFinite(d.getTime()) ? fmt(d) : null;
    }
    const s = String(input).trim();
    const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
    const idDate = s.match(/(\d{1,2})\s+([A-Za-z]+)\.?\s+(\d{4})/);
    if (idDate) {
      const mon = MONTHS_ID[idDate[2].toLowerCase()];
      if (mon) return `${idDate[3]}-${pad(mon)}-${pad(Number(idDate[1]))}`;
    }
    const parsed = Date.parse(s);
    if (Number.isFinite(parsed)) return fmt(new Date(parsed));
    return null;
  };

  NS.todayISO = function todayISO() {
    return fmt(new Date());
  };

  /** Coerce to a positive integer >= 1 (quantities); fallback 1. */
  NS.toQty = function toQty(value) {
    const n = Math.round(Number(value));
    return Number.isFinite(n) && n >= 1 ? n : 1;
  };

  /** First non-empty value among `keys` on `obj`. */
  NS.pick = function pick(obj, keys) {
    if (!obj || typeof obj !== 'object') return null;
    for (const k of keys) {
      const v = obj[k];
      if (v != null && v !== '') return v;
    }
    return null;
  };

  /** De-duplicate a list of scraped orders by invoiceNumber (keeps first). */
  NS.dedupeOrders = function dedupeOrders(orders) {
    const byInv = new Map();
    for (const o of orders || []) {
      if (o && o.invoiceNumber && !byInv.has(o.invoiceNumber)) {
        byInv.set(o.invoiceNumber, o);
      }
    }
    return [...byInv.values()];
  };
})();

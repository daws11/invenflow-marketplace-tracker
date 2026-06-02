// Service worker (Manifest V3, native ES module). Owns:
//   - config (tracker base URL + extension key, in chrome.storage.sync)
//   - scheduling (one chrome.alarm per account at the next cron occurrence of
//     its `cronScheduleDibayar`, plus a periodic resync alarm)
//   - the scrape pipeline: open the account's purchase-list tab in the
//     background, wait for the content-script bridge to report the orders,
//     close the tab, POST them to the tracker's /api/ingest.
//
// Accounts are scraped strictly one at a time with a human-ish gap between
// them. The extension never crafts marketplace API calls — the bridge only
// observes the page's own traffic — so the anti-bot surface stays human-like.

import { nextFireFromCron } from './lib/cron.js';

const DEFAULT_TRACKER_URL = 'https://tracker.ptunicorn.id';
const SCRAPE_TIMEOUT_MS = 150_000;
const BETWEEN_ACCOUNTS_MIN_MS = 6_000;
const BETWEEN_ACCOUNTS_SPREAD_MS = 12_000;
const RESYNC_ALARM = 'if-resync';
const RESYNC_PERIOD_MIN = 30;

// ---------------------------------------------------------------------------
// Config + tracker HTTP
// ---------------------------------------------------------------------------

async function getConfig() {
  const { trackerBaseUrl, extensionKey } = await chrome.storage.sync.get(['trackerBaseUrl', 'extensionKey']);
  return {
    trackerBaseUrl: (trackerBaseUrl || DEFAULT_TRACKER_URL).replace(/\/+$/, ''),
    extensionKey: extensionKey || '',
  };
}

async function trackerFetch(path, init = {}) {
  const { trackerBaseUrl, extensionKey } = await getConfig();
  if (!extensionKey) throw new Error('Extension key not set — open the extension Options page.');
  const res = await fetch(trackerBaseUrl + path, {
    ...init,
    headers: {
      'content-type': 'application/json',
      'x-extension-key': extensionKey,
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) {
    const msg = body && typeof body === 'object' && body.error ? body.error : `HTTP ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

async function fetchAccounts() {
  const data = await trackerFetch('/api/extension/accounts', { method: 'GET' });
  return (data && data.accounts) || [];
}

// ---------------------------------------------------------------------------
// Per-account status (chrome.storage.local, key "status:<id>")
// ---------------------------------------------------------------------------

async function setAccountStatus(accountId, patch) {
  const key = 'status:' + accountId;
  const cur = (await chrome.storage.local.get(key))[key] || {};
  await chrome.storage.local.set({
    [key]: { ...cur, ...patch, accountId, updatedAt: new Date().toISOString() },
  });
}

async function getAllStatuses() {
  const all = await chrome.storage.local.get(null);
  return Object.entries(all)
    .filter(([k]) => k.startsWith('status:'))
    .map(([, v]) => v);
}

// ---------------------------------------------------------------------------
// Scrape one account
// ---------------------------------------------------------------------------

// tabId -> { resolve, timer }
const pending = new Map();

function waitForTabComplete(tabId) {
  return new Promise((resolve) => {
    function listener(id, info) {
      if (id === tabId && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
    // Safety: if the tab was already complete (race), resolve after a beat.
    chrome.tabs.get(tabId).then((t) => {
      if (t && t.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }).catch(() => {});
  });
}

function jitter(base, spread) {
  return base + Math.floor(Math.random() * spread);
}

// Per-platform fallback purchase-list URLs (mirror the server defaults in
// apps/web/src/app/api/extension/accounts/route.ts).
const PURCHASE_URL_DEFAULTS = {
  tokopedia: 'https://www.tokopedia.com/order-list',
  shopee: 'https://shopee.co.id/user/purchase?type=2',
};

// Resolve the URL to open for an account, defensively.
// - Tokopedia ignores a `?status=` query (filtering is the GraphQL `Status`
//   variable / on-page tabs, not the URL). An old default — or a stale
//   `paidUrlOverride` — may still carry `?status=dibayar`, which is harmless but
//   pointless; strip it so capture is deterministic.
// - Shopee's `?type=` DOES select the tab, so it is preserved as-is.
// - Falls back to the platform default if the server sent nothing usable.
function purchaseUrlFor(account) {
  const platform = String(account && account.platform || '').toLowerCase();
  const fallback = PURCHASE_URL_DEFAULTS[platform] || PURCHASE_URL_DEFAULTS.tokopedia;
  const raw = String((account && account.paidUrl) || '').trim();
  if (!raw) return fallback;
  let u;
  try {
    u = new URL(raw);
  } catch {
    return fallback;
  }
  if (platform === 'tokopedia' && /\/order-list/.test(u.pathname)) {
    u.searchParams.delete('status');
  }
  return u.toString().replace(/\?$/, '');
}

async function scrapeAccount(account, triggeredBy) {
  await setAccountStatus(account.id, {
    name: account.name,
    platform: account.platform,
    state: 'running',
    lastStartedAt: new Date().toISOString(),
    lastError: null,
  });

  const purchaseUrl = purchaseUrlFor(account);
  console.log('[if-scrape] open', account.platform, '|', account.name, '->', purchaseUrl);
  let tab;
  try {
    tab = await chrome.tabs.create({ url: purchaseUrl, active: false });
  } catch (e) {
    await setAccountStatus(account.id, { state: 'error', lastError: 'Could not open tab: ' + ((e && e.message) || e) });
    return;
  }
  const tabId = tab.id;

  const result = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (pending.has(tabId)) {
        pending.delete(tabId);
        resolve({ orders: [], error: 'timeout' });
      }
    }, SCRAPE_TIMEOUT_MS);
    pending.set(tabId, { resolve, timer });

    waitForTabComplete(tabId).then(() => {
      setTimeout(() => {
        chrome.tabs.sendMessage(
          tabId,
          { type: 'scrapeThisTab', accountId: account.id, platform: account.platform },
          () => void chrome.runtime.lastError,
        );
      }, jitter(1500, 1500));
    });
  });

  try {
    await chrome.tabs.remove(tabId);
  } catch {
    /* ignore */
  }

  console.log('[if-scrape] result', account.name, {
    orders: Array.isArray(result.orders) ? result.orders.length : 0,
    rawCount: result.rawCount,
    error: result.error || null,
  });

  if (result.error === 'session_expired') {
    await setAccountStatus(account.id, {
      state: 'session_expired',
      lastError: `Session expired — open ${account.platform} in this Chrome profile and log in again.`,
    });
    return;
  }
  if (result.error === 'timeout') {
    await setAccountStatus(account.id, { state: 'error', lastError: 'Timed out waiting for the order list to load.' });
    return;
  }

  const orders = Array.isArray(result.orders) ? result.orders : [];
  if (orders.length === 0) {
    await setAccountStatus(account.id, {
      state: result.error ? 'error' : 'ok',
      lastFinishedAt: new Date().toISOString(),
      lastError: result.error || null,
      orderCount: 0,
      parseRawCount: result.rawCount ?? null,
    });
    return; // nothing to POST
  }

  try {
    const resp = await trackerFetch('/api/ingest', {
      method: 'POST',
      body: JSON.stringify({
        accountId: account.id,
        platform: account.platform,
        pass: 'paid',
        triggeredBy,
        orders,
      }),
    });
    console.log('[if-scrape] ingest OK', account.name, resp);
    await setAccountStatus(account.id, {
      state: 'ok',
      lastFinishedAt: new Date().toISOString(),
      lastError: result.error || null,
      orderCount: orders.length,
      newOrderCount: resp && resp.newOrderCount,
      failedSyncs: resp && resp.failedSyncs,
      runId: resp && resp.runId,
      parseRawCount: result.rawCount ?? null,
    });
  } catch (e) {
    console.error('[if-scrape] ingest FAIL', account.name, 'status=', e && e.status, '|', (e && e.message) || e);
    await setAccountStatus(account.id, {
      state: 'error',
      lastFinishedAt: new Date().toISOString(),
      lastError: 'POST /api/ingest: ' + ((e && e.message) || e),
      orderCount: orders.length,
    });
  }
}

let scrapeChainRunning = false;
async function runScrape(onlyAccountId, triggeredBy) {
  if (scrapeChainRunning) throw new Error('A scrape is already in progress.');
  scrapeChainRunning = true;
  try {
    const accounts = await fetchAccounts();
    const targets = onlyAccountId ? accounts.filter((a) => a.id === onlyAccountId) : accounts;
    console.log('[if-scrape] runScrape', { triggeredBy, targets: targets.map((a) => a.name) });
    for (let i = 0; i < targets.length; i++) {
      // eslint-disable-next-line no-await-in-loop
      await scrapeAccount(targets[i], triggeredBy);
      if (i < targets.length - 1) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, jitter(BETWEEN_ACCOUNTS_MIN_MS, BETWEEN_ACCOUNTS_SPREAD_MS)));
      }
    }
  } finally {
    scrapeChainRunning = false;
  }
}

// ---------------------------------------------------------------------------
// Messaging (content scripts + popup/options)
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return undefined;

  // Content-script bridge reporting its result.
  if (msg.type === 'orders') {
    const tabId = sender.tab && sender.tab.id;
    if (tabId != null && pending.has(tabId)) {
      const p = pending.get(tabId);
      clearTimeout(p.timer);
      pending.delete(tabId);
      p.resolve(msg);
    }
    return undefined;
  }

  // Popup: "scrape now".
  if (msg.type === 'scrapeNow') {
    runScrape(msg.accountId || null, 'manual')
      .then(() => sendResponse({ ok: true }))
      .catch((e) => {
        console.error('[if-scrape] scrapeNow FAILED (e.g. GET /api/extension/accounts rejected)', e && e.status, (e && e.message) || e);
        sendResponse({ ok: false, error: String((e && e.message) || e) });
      });
    return true; // keep the channel open for the async response
  }

  // Popup: current per-account status.
  if (msg.type === 'getState') {
    getAllStatuses().then((statuses) => sendResponse({ statuses }));
    return true;
  }

  // Options: config changed — re-bootstrap (re-arm alarms, etc).
  if (msg.type === 'configChanged') {
    bootstrap().catch(() => {});
    sendResponse({ ok: true });
    return true;
  }

  return undefined;
});

// ---------------------------------------------------------------------------
// Scheduling
// ---------------------------------------------------------------------------

async function rearmAlarms() {
  let accounts;
  try {
    accounts = await fetchAccounts();
  } catch {
    return; // leave alarms untouched; the resync alarm will retry
  }
  const wanted = new Set(accounts.map((a) => 'acct:' + a.id));
  const existing = await chrome.alarms.getAll();
  for (const al of existing) {
    if (al.name.startsWith('acct:') && !wanted.has(al.name)) {
      await chrome.alarms.clear(al.name);
    }
  }
  for (const a of accounts) {
    const when = nextFireFromCron(a.cronScheduleDibayar);
    if (when) {
      await chrome.alarms.create('acct:' + a.id, { when });
      await setAccountStatus(a.id, { name: a.name, platform: a.platform, nextRunAt: new Date(when).toISOString() });
    }
  }
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === RESYNC_ALARM) {
    await rearmAlarms();
    return;
  }
  if (alarm.name.startsWith('acct:')) {
    const accountId = alarm.name.slice('acct:'.length);
    try {
      const accounts = await fetchAccounts();
      const account = accounts.find((x) => x.id === accountId);
      if (account) {
        await runScrape(accountId, 'scheduled').catch(() => {});
        const when = nextFireFromCron(account.cronScheduleDibayar);
        if (when) {
          await chrome.alarms.create('acct:' + account.id, { when });
          await setAccountStatus(account.id, { nextRunAt: new Date(when).toISOString() });
        }
      }
    } catch {
      /* ignore — resync alarm recovers */
    }
  }
});

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

async function bootstrap() {
  await chrome.alarms.create(RESYNC_ALARM, { periodInMinutes: RESYNC_PERIOD_MIN });
  const { extensionKey } = await getConfig();
  if (!extensionKey) {
    try {
      chrome.runtime.openOptionsPage();
    } catch {
      /* ignore */
    }
    return;
  }
  await rearmAlarms();
}

chrome.runtime.onInstalled.addListener(() => {
  bootstrap().catch(() => {});
});
chrome.runtime.onStartup.addListener(() => {
  bootstrap().catch(() => {});
});
// Also when the service worker first spins up (covers extension reloads).
bootstrap().catch(() => {});

// Content-script bridge (isolated world, document_start). Injects
// inject-main.js into the page (MAIN) world, collects the API responses it
// forwards, drives the page's own "load more" / infinite scroll to pull every
// page of orders, then asks the per-platform parser to turn the raw responses
// (+ DOM as a fallback) into a list of scraped orders and hands the result to
// the background service worker.
//
// It only runs when the background tells it which account this tab is for
// (`scrapeThisTab` message) — so opening an order-list page by hand does not
// trigger a scrape.
(() => {
  const NS = globalThis.__ifScraper || (globalThis.__ifScraper = {});
  const SOURCE = 'invenflow-ext';
  const PLATFORM = location.host.indexOf('tokopedia') !== -1 ? 'tokopedia' : 'shopee';

  // Login-redirect signals — landing on one means the session expired.
  const LOGIN_SIGNALS =
    PLATFORM === 'tokopedia'
      ? ['/login', 'sso/login', 'accounts.tokopedia.com']
      : ['/buyer/login', 'login_signup', '/sso/login', 'shopee.co.id/buyer/login'];

  // 1. Inject the MAIN-world interceptor as early as possible.
  try {
    const s = document.createElement('script');
    s.src = chrome.runtime.getURL('content/inject-main.js');
    s.onload = () => s.remove();
    (document.head || document.documentElement).appendChild(s);
  } catch (e) {
    /* ignore — DOM not ready yet is unlikely at document_start, but be safe */
  }

  // 2. Collect responses forwarded by inject-main.
  const responses = [];
  window.addEventListener('message', (ev) => {
    if (ev.source !== window) return;
    const d = ev.data;
    if (!d || d.source !== SOURCE || !d.body) return;
    responses.push({ url: d.url, body: d.body });
  });

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const jitter = (base, spread) => base + Math.floor(Math.random() * spread);

  function looksLoggedOut() {
    const u = location.href;
    return LOGIN_SIGNALS.some((sig) => u.indexOf(sig) !== -1);
  }

  // 3. Pagination: scroll to the bottom repeatedly (infinite scroll) and click
  //    any "load more" / "muat lebih" button. Human-paced; time- and
  //    iteration-capped.
  async function loadAllPages() {
    const deadline = Date.now() + 60_000;
    let lastHeight = 0;
    let stale = 0;
    for (let i = 0; i < 30 && Date.now() < deadline; i++) {
      const btn = [...document.querySelectorAll('button, a')].find((el) => {
        const t = (el.textContent || '').trim().toLowerCase();
        return (
          t.includes('muat lebih') ||
          t.includes('load more') ||
          t === 'lihat lebih banyak' ||
          t === 'tampilkan lebih banyak'
        );
      });
      if (btn && btn.offsetParent !== null) {
        try {
          btn.click();
        } catch (e) {
          /* ignore */
        }
        await sleep(jitter(1200, 1500));
      }
      window.scrollTo(0, document.body.scrollHeight);
      await sleep(jitter(900, 1200));
      const h = document.body.scrollHeight;
      if (h === lastHeight && !(btn && btn.offsetParent !== null)) {
        stale += 1;
        if (stale >= 2) break;
        await sleep(jitter(700, 600));
      } else {
        stale = 0;
      }
      lastHeight = h;
    }
    window.scrollTo(0, 0);
  }

  let started = false;
  async function run(info) {
    if (started) return;
    started = true;
    const accountId = (info && info.accountId) || null;
    const send = (extra) =>
      chrome.runtime.sendMessage({ type: 'orders', platform: PLATFORM, accountId, ...extra }, () => void chrome.runtime.lastError);

    try {
      if (document.readyState !== 'complete') {
        await new Promise((r) => window.addEventListener('load', r, { once: true }));
      }
      await sleep(jitter(1500, 1500));

      if (looksLoggedOut()) {
        send({ orders: [], error: 'session_expired' });
        return;
      }

      await loadAllPages();
      await sleep(jitter(800, 700));

      let orders = [];
      let parseError = null;
      try {
        const parser = NS.parsers && NS.parsers[PLATFORM];
        if (typeof parser !== 'function') throw new Error('no parser registered for ' + PLATFORM);
        orders = parser({ responses, document }) || [];
      } catch (e) {
        parseError = 'parse: ' + String((e && e.message) || e);
      }

      // Re-check login state — some sites only redirect after data loads.
      if (orders.length === 0 && looksLoggedOut()) {
        send({ orders: [], error: 'session_expired' });
        return;
      }

      send({ orders, error: parseError, rawCount: responses.length, visibility: document.visibilityState });
    } catch (e) {
      send({ orders: [], error: 'bridge_crash: ' + String((e && e.message) || e) });
    }
  }

  // The background opens this tab and, once it has finished loading, sends
  // `scrapeThisTab` telling us which account it is for.
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'scrapeThisTab') {
      run(msg);
    }
  });
})();

// Runs in the PAGE's JS context (the "MAIN" world). Monkey-patches `fetch` and
// `XMLHttpRequest` so we can *observe* the page's own API responses — we never
// craft requests ourselves, which keeps the anti-bot surface identical to a
// human. Matching responses are forwarded to the content-script bridge via
// `window.postMessage`; the bridge does the parsing.
(() => {
  if (window.__ifInterceptorInstalled) return;
  window.__ifInterceptorInstalled = true;

  const SOURCE = 'invenflow-ext';

  // URL substrings we care about — deliberately broad; the bridge filters
  // further. Covers Tokopedia order-history GraphQL and Shopee order-list v4.
  // Refine after inspecting real traffic with DevTools.
  const PATTERNS = [
    '/graphql', // Tokopedia (gql.tokopedia.com)
    'get_all_order_and_checkout_list', // Shopee buyer order list
    'get_order_list', // Shopee (older variants)
    'get_order_detail', // Shopee order detail
    'order_list', // generic fallback
  ];

  function matches(url) {
    try {
      const u = String(url);
      return PATTERNS.some((p) => u.indexOf(p) !== -1);
    } catch {
      return false;
    }
  }

  function emit(url, bodyText) {
    if (typeof bodyText !== 'string' || bodyText.length === 0) return;
    let body;
    try {
      body = JSON.parse(bodyText);
    } catch {
      return; // not JSON — ignore
    }
    try {
      window.postMessage({ source: SOURCE, url: String(url), body }, location.origin);
    } catch {
      /* ignore */
    }
  }

  // ---- fetch ----
  const origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function patchedFetch(...args) {
      const reqUrl = args[0] && typeof args[0] === 'object' && 'url' in args[0] ? args[0].url : args[0];
      const p = origFetch.apply(this, args);
      try {
        return p.then((res) => {
          try {
            if (res && (matches(reqUrl) || matches(res.url))) {
              res
                .clone()
                .text()
                .then((t) => emit(res.url || reqUrl, t))
                .catch(() => {});
            }
          } catch {
            /* ignore */
          }
          return res;
        });
      } catch {
        return p;
      }
    };
  }

  // ---- XMLHttpRequest ----
  const XHR = window.XMLHttpRequest;
  if (XHR && XHR.prototype) {
    const origOpen = XHR.prototype.open;
    const origSend = XHR.prototype.send;
    XHR.prototype.open = function patchedOpen(method, url, ...rest) {
      try {
        this.__ifUrl = url;
      } catch {
        /* ignore */
      }
      return origOpen.call(this, method, url, ...rest);
    };
    XHR.prototype.send = function patchedSend(...args) {
      try {
        this.addEventListener('loadend', () => {
          try {
            const url = this.__ifUrl || this.responseURL;
            if (!matches(url)) return;
            let text = null;
            if (this.responseType === '' || this.responseType === 'text') {
              text = this.responseText;
            } else if (typeof this.response === 'string') {
              text = this.response;
            }
            if (text) emit(url, text);
          } catch {
            /* ignore */
          }
        });
      } catch {
        /* ignore */
      }
      return origSend.apply(this, args);
    };
  }
})();

// Runs in the PAGE's JS context (the "MAIN" world; injected via a world:MAIN
// content_scripts entry at document_start so the patch is in place before the
// page's own scripts run). Observes the page's own API responses — it crafts NO
// requests, so the anti-bot surface stays identical to a human. Capture paths:
//   1. Wrap Response.prototype.json/.text to read the body the page itself reads.
//      This is immune to the page aborting its fetch after reading (Tokopedia
//      uses AbortController, which cancels a clone()'s still-pending read with
//      "The user aborted a request").
//   2. A clone()-based fetch read, as a silent fallback for bodies the page
//      reads via some other method.
//   3. XMLHttpRequest, for XHR-based responses (e.g. Shopee).
// Matching responses are forwarded to the content-script bridge via
// window.postMessage; the bridge parses them.
(() => {
  if (window.__ifInterceptorInstalled) return;
  window.__ifInterceptorInstalled = true;

  const SOURCE = 'invenflow-ext';

  // URL substrings we care about — deliberately broad; the bridge/parsers filter
  // further. Covers Tokopedia order-history GraphQL and Shopee order-list v4.
  const PATTERNS = [
    '/graphql', // Tokopedia (gql.tokopedia.com)
    'get_all_order_and_checkout_list', // Shopee buyer order list
    'get_order_list', // Shopee
    'get_order_detail', // Shopee order detail
    'order_list', // generic fallback
  ];

  function matches(url) {
    try {
      return PATTERNS.some((p) => String(url).indexOf(p) !== -1);
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

  // ---- Primary capture: piggyback on the page's own body read ----
  function captureRead(url, data) {
    try {
      emit(url, typeof data === 'string' ? data : JSON.stringify(data));
    } catch {
      /* ignore */
    }
  }
  ['json', 'text'].forEach((m) => {
    const orig = Response.prototype[m];
    if (typeof orig !== 'function') return;
    Response.prototype[m] = function patchedBodyReader() {
      const p = orig.apply(this, arguments);
      try {
        const u = this.url;
        if (u && matches(u)) p.then((d) => captureRead(u, d)).catch(() => {});
      } catch {
        /* ignore */
      }
      return p;
    };
  });

  // ---- fetch: passthrough + silent clone() fallback ----
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

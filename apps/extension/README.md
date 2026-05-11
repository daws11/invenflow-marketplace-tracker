# InvenFlow Tracker Scraper (Chrome extension)

A Manifest V3 Chrome extension that scrapes **Tokopedia** and **Shopee** *buyer
purchase lists* in a real browser and POSTs the orders to the
`invenflow-marketplace-tracker` app, which forwards them into InvenFlow.

Why an extension instead of the server-side Playwright worker: Tokopedia and
Shopee anti-bot reliably blocks headless / automated browsers (even from a
residential Indonesian IP). Running inside the operator's real Chrome — normal
profile, a login session a human established, a residential IP — has none of
those signals. The extension never crafts marketplace API calls itself; it just
opens the order-list page, observes the page's own API responses (and the DOM as
a fallback), and uploads the parsed orders. Pacing mimics a human.

## How it works

- **`background.js`** (service worker) — reads config (`trackerBaseUrl` +
  `extensionKey` from `chrome.storage.sync`), fetches the account list from
  `GET {tracker}/api/extension/accounts`, arms one `chrome.alarms` alarm per
  account at the next occurrence of that account's `cronScheduleDibayar`, and on
  alarm (or the popup's "Scrape now") opens the account's purchase-list URL in a
  background tab, waits for the content script to report orders, closes the tab,
  and POSTs `POST {tracker}/api/ingest`. Accounts are scraped one at a time with
  a randomised gap between them.
- **`content/inject-main.js`** — injected into the page's own JS context; wraps
  `fetch` / `XMLHttpRequest` to forward matching API responses to the bridge.
- **`content/bridge.js`** — content script (isolated world); injects the above,
  collects the responses, scrolls / clicks "load more" to page through all
  orders (human-paced), then runs the per-platform parser.
- **`content/parse-tokopedia.js`, `content/parse-shopee.js`** — turn the
  captured API JSON (with a DOM fallback) into the order shape `/api/ingest`
  expects. **⚠️ The exact marketplace API shapes still need confirming with
  DevTools on a logged-in account** — the key names in these files are
  best-guesses; the JSON path is wrapped so it falls back to coarse DOM scraping
  until tightened. See "Verifying / tightening the parsers" below.
- **`options.html/js`** — set the tracker URL + extension key; "Test
  connection".
- **`popup.html/js`** — per-account status, "Scrape now".

`/api/ingest` only handles the **paid ("dibayar")** pass today; the shipped pass
is a follow-up.

## Build

No bundler — there is nothing to bundle. `build.mjs` just copies the loadable
files into `dist/`:

```sh
pnpm --filter @invenflow-tracker/extension build
# or, from this directory:
node build.mjs
```

You can equally load this directory directly in Chrome; `dist/` just keeps the
loaded folder free of `package.json` / `README.md` / `build.mjs`.

## Install (on the home-server Chrome)

1. In the Chrome profile you'll use, **log in to Tokopedia
   (`https://www.tokopedia.com`) and Shopee (`https://shopee.co.id`)** and keep
   the sessions ("stay signed in").
2. `chrome://extensions` → enable **Developer mode** → **Load unpacked** →
   select `apps/extension/dist` (or `apps/extension/`).
3. The Options page opens automatically the first time. Set:
   - **Tracker base URL** — e.g. `https://tracker.ptunicorn.id`
   - **Extension key** — from the tracker: **Settings → Extension → Generate
     key** (shown once). If you use a tracker URL other than the default, Chrome
     will prompt to grant host access to that origin when you click **Save**.
   Click **Save**, then **Test connection** — it should report the number of
   accounts configured in the tracker.
4. The extension will now scrape each account on its `cronScheduleDibayar`
   schedule (configured per-account in the tracker UI). Use the toolbar popup to
   trigger a scrape immediately or to check status.

Tip: Chrome must be running for scheduled scrapes to fire. A Windows "at logon"
scheduled task launching `chrome.exe --start-minimized` keeps `chrome.alarms`
alive without anyone opening Chrome.

## Verifying / tightening the parsers

On the logged-in home-server Chrome, open DevTools → Network on
`https://www.tokopedia.com/order-list?status=dibayar` and
`https://shopee.co.id/user/purchase?type=2`. Identify the request(s) that return
the order list as JSON (Tokopedia: a `gql.tokopedia.com/graphql` operation;
Shopee: likely `…/api/v4/order/get_all_order_and_checkout_list`). Note the URL
pattern, request body, and which response fields hold the invoice/order id,
order date, shop name, products (name / URL / qty / unit price / subtotal),
shipping fee, discount, and total. Then tighten:

- `content/inject-main.js` → `PATTERNS` (the URL substrings it captures)
- `content/parse-tokopedia.js` / `content/parse-shopee.js` → the key names and
  the price scaling (`shopeePrice` assumes ÷100000)
- `content/bridge.js` → the pagination controls / login-redirect signals

The bridge logs how many API responses it captured (`rawCount`) into the popup
status, which helps tell "parser missed the data" apart from "page didn't load
the data".

## Notes

- The extension talks only to the tracker (`/api/extension/accounts`,
  `/api/ingest`) — it knows nothing about WSL / Tailscale / Cloudflare. Both
  endpoints require the `x-extension-key` header (the key above).
- It does **not** scrape on a manual visit to an order-list page — only when the
  background worker tells it to (scheduled alarm or "Scrape now").
- Screenshots are not uploaded yet (`/api/ingest` accepts an optional
  base64 screenshot per order; wiring `chrome.tabs.captureVisibleTab` in is a
  follow-up).

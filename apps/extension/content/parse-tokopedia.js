// Tokopedia buyer order-list parser.
//
// Tokopedia renders /order-list via a GraphQL operation `GetOrderHistory`
// (field `uohOrders`) on gql.tokopedia.com. The shape was confirmed against
// real logged-in traffic (see fixtures/tokopedia-orderlist.json): the rich,
// reliable data lives inside `metadata` as TWO JSON-encoded STRING fields —
// `listProducts` (the line items) and `queryParams` (invoice, shop, etc.) — so
// the primary path below parses those explicitly. A generic GraphQL walker and
// a DOM scrape are kept as defensive fallbacks.
(() => {
  const NS = (globalThis.__ifScraper = globalThis.__ifScraper || {});
  NS.parsers = NS.parsers || {};
  const { parseRupiah, parseRupiahOrNull, toISODate, todayISO, toQty, pick, dedupeOrders } = NS;

  const TOKO_ORIGIN = 'https://www.tokopedia.com';

  function parseJsonSafe(str) {
    if (typeof str !== 'string' || str.trim() === '') return null;
    try {
      return JSON.parse(str);
    } catch (e) {
      return null;
    }
  }

  function absoluteUrl(u) {
    if (!u || typeof u !== 'string') return null;
    if (/^https?:\/\//i.test(u)) return u;
    return TOKO_ORIGIN + (u.charAt(0) === '/' ? u : '/' + u);
  }

  // ---- Primary path: the real `uohOrders` response shape -------------------

  function mapUohOrder(order) {
    const md = order && order.metadata;
    if (!md || typeof md !== 'object') return null;

    const qp = parseJsonSafe(md.queryParams) || {};
    const list = parseJsonSafe(md.listProducts);
    const products = Array.isArray(md.products) ? md.products : [];

    const invoiceNumber = String(qp.invoice || order.verticalID || qp.order_id || '').trim();
    if (!invoiceNumber) return null;

    let lineItems = [];
    if (Array.isArray(list) && list.length) {
      lineItems = list
        .map((it, idx) => {
          const qty = toQty(it.quantity ?? it.qty ?? 1);
          const unitPrice = parseRupiah(it.product_price ?? it.price ?? it.original_price ?? 0);
          const fallbackTitle = (products[idx] && products[idx].title) || '';
          return {
            marketplaceProductName: String(it.product_name || fallbackTitle || 'Unknown product').trim(),
            marketplaceProductUrl: null, // list response has no canonical product URL (no slug)
            quantity: qty,
            unitPrice: unitPrice || 0,
            subtotal: (unitPrice || 0) * qty,
          };
        })
        .filter((li) => li.marketplaceProductName);
    }

    // Fallback: no parseable listProducts -> use the display-only products[]
    // (titles + a "N barang" qty label), with prices we cannot know set to 0.
    if (lineItems.length === 0 && products.length) {
      lineItems = products
        .map((pr) => {
          const qtyLabel = (pr.inline1 && pr.inline1.label) || '';
          const qtyMatch = String(qtyLabel).match(/(\d+)/);
          return {
            marketplaceProductName: String(pr.title || 'Unknown product').trim(),
            marketplaceProductUrl: null,
            quantity: toQty(qtyMatch ? qtyMatch[1] : 1),
            unitPrice: 0,
            subtotal: 0,
          };
        })
        .filter((li) => li.marketplaceProductName);
    }

    if (lineItems.length === 0) return null;

    const totalAmount =
      parseRupiah(md.totalPrice && md.totalPrice.value) ||
      lineItems.reduce((s, li) => s + li.subtotal, 0);

    const detailUrl =
      (md.detailURL && absoluteUrl(md.detailURL.webURL)) || qp.invoice_url || null;

    return {
      invoiceNumber,
      orderDate:
        toISODate(md.paymentDateStr) ||
        toISODate(md.paymentDate) ||
        toISODate(order.createTime) ||
        todayISO(),
      sellerName: qp.shop_name || null,
      lineItems,
      // The order-list response does NOT break out shipping/discount; the only
      // money figure is the grand total. Leave these null (a detail-page fetch
      // would be needed to populate them).
      shippingFee: null,
      discount: null,
      totalAmount,
      detailUrl,
    };
  }

  function fromUohOrders(responses) {
    const out = [];
    for (const { body } of responses) {
      const envelopes = Array.isArray(body) ? body : [body];
      for (const env of envelopes) {
        const uoh = env && env.data && env.data.uohOrders;
        const orders = uoh && Array.isArray(uoh.orders) ? uoh.orders : null;
        if (!orders) continue;
        for (const o of orders) {
          const mapped = mapUohOrder(o);
          if (mapped) out.push(mapped);
        }
      }
    }
    return dedupeOrders(out);
  }

  // ---- Fallback A: generic GraphQL walker (pre-uohOrders best-guess) --------

  function looksLikeOrder(el) {
    if (!el || typeof el !== 'object') return false;
    const hasInvoice = ['invoice', 'invoiceRefNum', 'invoice_ref_num', 'invoiceUrl', 'orderId', 'order_id', 'paymentId'].some(
      (k) => typeof el[k] === 'string' && el[k].length > 0,
    );
    const products = el.products || el.orderProducts || el.order_products || el.items || el.detail;
    return hasInvoice && Array.isArray(products) && products.length > 0;
  }

  function mapGenericOrder(el) {
    const invoiceNumber = String(pick(el, ['invoice', 'invoiceRefNum', 'invoice_ref_num', 'orderId', 'order_id']) || '').trim();
    if (!invoiceNumber) return null;
    const products = el.products || el.orderProducts || el.order_products || el.items || el.detail || [];
    const lineItems = (Array.isArray(products) ? products : [])
      .map((pr) => {
        const qty = toQty(pick(pr, ['quantity', 'qty', 'amount']) ?? 1);
        const unitPrice = parseRupiah(pick(pr, ['price', 'productPrice', 'product_price', 'priceText', 'price_text']) ?? 0);
        let subtotal = parseRupiah(pick(pr, ['totalPrice', 'total_price', 'subtotalPrice', 'subtotal']) ?? 0);
        if (!subtotal && unitPrice) subtotal = unitPrice * qty;
        return {
          marketplaceProductName: String(pick(pr, ['name', 'productName', 'product_name', 'title']) || 'Unknown product').trim(),
          marketplaceProductUrl: pick(pr, ['url', 'productUrl', 'product_url', 'uri']) || null,
          quantity: qty,
          unitPrice: unitPrice || 0,
          subtotal: subtotal || (unitPrice || 0) * qty,
        };
      })
      .filter((li) => li.marketplaceProductName);
    if (lineItems.length === 0) return null;
    const totalAmount =
      parseRupiah(pick(el, ['totalAmount', 'total_amount', 'paymentAmount', 'payment_amount', 'grandTotal', 'totalPrice']) ?? 0) ||
      lineItems.reduce((s, li) => s + li.subtotal, 0);
    return {
      invoiceNumber,
      orderDate:
        toISODate(pick(el, ['createTime', 'create_time', 'paymentDate', 'payment_date', 'orderDate', 'transactionDate', 'date'])) ||
        todayISO(),
      sellerName: pick(el, ['shopName', 'shop_name', 'sellerName', 'storeName', 'store_name']) || null,
      lineItems,
      shippingFee: parseRupiahOrNull(pick(el, ['shippingCost', 'shipping_cost', 'logisticPrice', 'logistic_price'])),
      discount: parseRupiahOrNull(pick(el, ['discountAmount', 'discount_amount', 'totalDiscount', 'total_discount'])),
      totalAmount,
      detailUrl: pick(el, ['detailUrl', 'orderDetailUrl', 'order_detail_url', 'invoiceUrl']) || null,
    };
  }

  function collectOrders(node, out, depth) {
    const d = depth || 0;
    if (!node || typeof node !== 'object' || d > 8) return;
    if (Array.isArray(node)) {
      for (const el of node) {
        if (looksLikeOrder(el)) {
          const o = mapGenericOrder(el);
          if (o) out.push(o);
        } else {
          collectOrders(el, out, d + 1);
        }
      }
      return;
    }
    for (const k of Object.keys(node)) collectOrders(node[k], out, d + 1);
  }

  function fromGraphqlGeneric(responses) {
    const orders = [];
    for (const { body } of responses) {
      const envelopes = Array.isArray(body) ? body : [body];
      for (const env of envelopes) {
        const root = env && env.data ? env.data : env;
        collectOrders(root, orders, 0);
      }
    }
    return dedupeOrders(orders);
  }

  // ---- Fallback B: DOM scrape ----------------------------------------------

  function fromDom(doc) {
    // DOM fallback — Tokopedia's order-list markup changes often, so this is a
    // coarse "one line item per order" approximation. Prefer the GraphQL path.
    const orders = [];
    const root = doc || document;
    const text = (root.body && root.body.innerText) || '';
    if (!/INV\/\w/.test(text)) return orders;
    const cards = [...root.querySelectorAll('[data-testid], article, section, li, div')].filter((el) => {
      const t = el.innerText || '';
      return /INV\/\w/.test(t) && t.length < 4000 && el.querySelector('img');
    });
    const seen = new Set();
    for (const card of cards) {
      const t = card.innerText || '';
      const inv = (t.match(/INV\/[A-Z0-9/]+/) || [])[0];
      if (!inv || seen.has(inv)) continue;
      seen.add(inv);
      const link = card.querySelector('a[href*="tokopedia"]');
      const name =
        (card.querySelector('[data-testid*="prdName"], [data-testid*="productName"]') || {}).innerText ||
        (link && link.innerText) ||
        (t.split('\n').find((l) => l.trim().length > 8 && !/INV\//.test(l) && !/Rp/.test(l)) || 'Unknown product');
      const prices = (t.match(/Rp[\s.\d]+/g) || []).map(parseRupiah).filter(Boolean);
      const totalAmount = prices.length ? Math.max(...prices) : 0;
      orders.push({
        invoiceNumber: inv,
        orderDate: toISODate((t.match(/\d{1,2}\s+[A-Za-z]+\.?\s+\d{4}/) || [])[0]) || todayISO(),
        sellerName: null,
        lineItems: [
          {
            marketplaceProductName: String(name).trim().slice(0, 200) || 'Unknown product',
            marketplaceProductUrl: (link && link.href) || null,
            quantity: 1,
            unitPrice: totalAmount,
            subtotal: totalAmount,
          },
        ],
        shippingFee: null,
        discount: null,
        totalAmount,
        detailUrl: null,
      });
    }
    return orders;
  }

  NS.parsers.tokopedia = function tokopediaParser({ responses, document: doc }) {
    const resp = responses || [];
    let orders = fromUohOrders(resp);
    if (orders.length === 0) orders = fromGraphqlGeneric(resp);
    if (orders.length === 0) orders = fromDom(doc || document);
    return orders;
  };
})();

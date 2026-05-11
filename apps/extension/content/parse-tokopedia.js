// Tokopedia buyer order-list parser.
//
// Tokopedia renders /order-list via GraphQL (gql.tokopedia.com). The exact
// operation name and response shape need confirming with DevTools on a
// logged-in account — so this parser is deliberately defensive: it walks any
// captured GraphQL response looking for arrays of "order-like" objects, and
// falls back to scraping the rendered order cards from the DOM. Treat the key
// names below as best-guesses to be tightened once real traffic is captured.
(() => {
  const NS = (globalThis.__ifScraper = globalThis.__ifScraper || {});
  NS.parsers = NS.parsers || {};
  const { parseRupiah, parseRupiahOrNull, toISODate, todayISO, toQty, pick, dedupeOrders } = NS;

  function looksLikeOrder(el) {
    if (!el || typeof el !== 'object') return false;
    const hasInvoice = ['invoice', 'invoiceRefNum', 'invoice_ref_num', 'invoiceUrl', 'orderId', 'order_id', 'paymentId'].some(
      (k) => typeof el[k] === 'string' && el[k].length > 0,
    );
    const products = el.products || el.orderProducts || el.order_products || el.items || el.detail;
    return hasInvoice && Array.isArray(products) && products.length > 0;
  }

  function mapOrder(el) {
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
          const o = mapOrder(el);
          if (o) out.push(o);
        } else {
          collectOrders(el, out, d + 1);
        }
      }
      return;
    }
    for (const k of Object.keys(node)) collectOrders(node[k], out, d + 1);
  }

  function fromGraphql(responses) {
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

  function fromDom(doc) {
    // DOM fallback — Tokopedia's order-list markup changes often, so this is a
    // coarse "one line item per order" approximation. Prefer the GraphQL path.
    const orders = [];
    const root = doc || document;
    const text = (root.body && root.body.innerText) || '';
    if (!/INV\/\d/.test(text)) return orders;
    const cards = [...root.querySelectorAll('[data-testid], article, section, li, div')].filter((el) => {
      const t = el.innerText || '';
      return /INV\/\d/.test(t) && t.length < 4000 && el.querySelector('img');
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
    let orders = fromGraphql(responses || []);
    if (orders.length === 0) orders = fromDom(doc || document);
    return orders;
  };
})();

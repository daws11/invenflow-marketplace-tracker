// Shopee buyer purchase-list parser.
//
// The /user/purchase page loads orders via (most likely)
// shopee.co.id/api/v4/order/get_all_order_and_checkout_list, returning
// data.order_data.details_list[] with shop-grouped items; prices are integers
// scaled by 100000 (5 decimal places). The exact shape needs confirming with
// DevTools on a logged-in account — this parser is defensive and falls back to
// DOM scraping. Tighten the key names once real traffic is captured.
(() => {
  const NS = (globalThis.__ifScraper = globalThis.__ifScraper || {});
  NS.parsers = NS.parsers || {};
  const { parseRupiah, toISODate, todayISO, toQty, pick, dedupeOrders } = NS;

  // Shopee monetary values are usually integers scaled by 100000.
  function shopeePrice(v) {
    if (v == null) return 0;
    if (typeof v === 'string') return parseRupiah(v);
    const n = Number(v);
    if (!Number.isFinite(n)) return 0;
    return n >= 100000 ? Math.round(n / 100000) : Math.max(0, Math.round(n));
  }
  function shopeePriceOrNull(v) {
    if (v == null) return null;
    return shopeePrice(v);
  }

  function mapShopOrder(so, parent) {
    if (!so || typeof so !== 'object') return null;
    const invoiceNumber = String(
      pick(so, ['order_sn', 'order_id', 'orderid', 'order_number']) || pick(parent, ['order_sn', 'checkout_id']) || '',
    ).trim();
    if (!invoiceNumber) return null;
    const items = so.item_list || so.items || so.order_items || (so.info_card && so.info_card.item_list) || [];
    const lineItems = (Array.isArray(items) ? items : [])
      .map((it) => {
        const qty = toQty(pick(it, ['amount', 'quantity', 'qty']) ?? 1);
        const unitPrice = shopeePrice(pick(it, ['item_price', 'price', 'model_price', 'price_before_discount']) ?? 0);
        let subtotal = shopeePrice(pick(it, ['order_price', 'total_price', 'item_total_price']) ?? 0);
        if (!subtotal && unitPrice) subtotal = unitPrice * qty;
        return {
          marketplaceProductName: String(pick(it, ['name', 'item_name', 'product_name']) || 'Unknown product').trim(),
          marketplaceProductUrl: it && it.shopid && it.itemid ? `https://shopee.co.id/product/${it.shopid}/${it.itemid}` : null,
          quantity: qty,
          unitPrice: unitPrice || 0,
          subtotal: subtotal || (unitPrice || 0) * qty,
        };
      })
      .filter((li) => li.marketplaceProductName);
    if (lineItems.length === 0) return null;
    const totalAmount =
      shopeePrice(pick(so, ['total_price', 'order_total', 'final_total', 'amount', 'pay_amount']) ?? 0) ||
      lineItems.reduce((s, li) => s + li.subtotal, 0);
    return {
      invoiceNumber,
      orderDate:
        toISODate(pick(so, ['create_time', 'ctime', 'pay_time', 'order_time', 'mtime'])) ||
        toISODate(pick(parent, ['create_time', 'ctime'])) ||
        todayISO(),
      sellerName: pick(so, ['shop_name', 'shopname']) || pick(parent, ['shop_name', 'shopname']) || null,
      lineItems,
      shippingFee: shopeePriceOrNull(pick(so, ['shipping_fee', 'estimated_shipping_fee', 'actual_shipping_fee', 'shipping_fee_paid_by_buyer'])),
      discount: shopeePriceOrNull(pick(so, ['voucher_discount', 'shop_voucher_discount', 'total_discount', 'coin_offset'])),
      totalAmount,
      detailUrl: `https://shopee.co.id/user/purchase/order/${invoiceNumber}`,
    };
  }

  function collectShopeeOrder(entry, out) {
    if (!entry || typeof entry !== 'object') return;
    const shopOrders =
      entry.shop_order_list ||
      entry.shop_orders ||
      (entry.info_card && entry.info_card.order_list) ||
      (entry.order_data && entry.order_data.shop_order_list) ||
      null;
    if (Array.isArray(shopOrders) && shopOrders.length) {
      for (const so of shopOrders) {
        const o = mapShopOrder(so, entry);
        if (o) out.push(o);
      }
      return;
    }
    const o = mapShopOrder(entry, entry);
    if (o) out.push(o);
  }

  function fromApi(responses) {
    const orders = [];
    for (const { body } of responses) {
      if (!body || typeof body !== 'object') continue;
      const buckets = [];
      const data = body.data || body;
      const dl =
        (data.order_data && (data.order_data.details_list || data.order_data.order_list)) ||
        data.details_list ||
        data.order_list ||
        data.orders ||
        null;
      if (Array.isArray(dl)) buckets.push(...dl);
      if (Array.isArray(body.details_list)) buckets.push(...body.details_list);
      for (const entry of buckets) collectShopeeOrder(entry, orders);
    }
    return dedupeOrders(orders);
  }

  function fromDom(doc) {
    const orders = [];
    const root = doc || document;
    const cards = [...root.querySelectorAll('div, section, li')].filter((el) => {
      const t = el.innerText || '';
      return /(No\.?\s*Pesanan|Order ID)/i.test(t) && t.length < 4000 && el.querySelector('img');
    });
    const seen = new Set();
    for (const card of cards) {
      const t = card.innerText || '';
      const inv = (t.match(/(?:No\.?\s*Pesanan|Order ID)\s*[:#]?\s*([A-Z0-9]+)/i) || [])[1];
      if (!inv || seen.has(inv)) continue;
      seen.add(inv);
      const prices = (t.match(/Rp[\s.\d]+/g) || []).map(parseRupiah).filter(Boolean);
      const totalAmount = prices.length ? Math.max(...prices) : 0;
      const name = t.split('\n').find((l) => l.trim().length > 8 && !/Pesanan|Order ID|Rp/i.test(l)) || 'Unknown product';
      orders.push({
        invoiceNumber: inv,
        orderDate:
          toISODate((t.match(/\d{4}-\d{2}-\d{2}/) || [])[0]) ||
          toISODate((t.match(/\d{1,2}\s+[A-Za-z]+\s+\d{4}/) || [])[0]) ||
          todayISO(),
        sellerName: null,
        lineItems: [
          {
            marketplaceProductName: String(name).trim().slice(0, 200) || 'Unknown product',
            marketplaceProductUrl: null,
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

  NS.parsers.shopee = function shopeeParser({ responses, document: doc }) {
    let orders = fromApi(responses || []);
    if (orders.length === 0) orders = fromDom(doc || document);
    return orders;
  };
})();

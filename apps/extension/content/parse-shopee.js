// Shopee buyer order-list parser.
//
// Shopee renders /user/purchase via REST JSON (NOT GraphQL):
//   GET https://shopee.co.id/api/v4/order/get_order_list?list_type=<tab>&offset=<n>
// (and get_checkout_list for unpaid carts). Shape confirmed against real
// logged-in traffic (see __fixtures__/shopee-orderlist.json):
//
//   data.details_list[]
//     .status.list_view_status_label.text   "label_completed" etc
//     .shipping.tracking_info.ctime         epoch secs (delivery time — used as
//                                           a best-effort order-date proxy)
//     .info_card
//       .order_id                           numeric — our invoiceNumber
//       .final_total / .subtotal            money, scaled x100000 (micro-rupiah)
//       .order_list_cards[]
//         .shop_info.shop_name              seller
//         .product_info.item_groups[].items[]
//           .name, .model_name (variation), .amount (qty)
//           .order_price / .item_price / .price_before_discount  (x100000)
//           .shop_id, .item_id              -> product URL
//
// IMPORTANT: Shopee money fields are integers scaled by 100000. The order-list
// payload has NO shipping/discount breakdown and NO order/payment date (only the
// delivery ctime), so those need the order-detail endpoint.
(() => {
  const NS = (globalThis.__ifScraper = globalThis.__ifScraper || {});
  NS.parsers = NS.parsers || {};
  const { toISODate, todayISO, toQty, dedupeOrders } = NS;

  const SHOPEE_ORIGIN = 'https://shopee.co.id';
  const PRICE_DIV = 100000; // Shopee prices are value * 100000.

  function money(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.round(n / PRICE_DIV));
  }

  function mapShopeeOrder(detail) {
    const card = detail && detail.info_card;
    if (!card || typeof card !== 'object') return null;

    const cards = Array.isArray(card.order_list_cards) ? card.order_list_cards : [];
    const invoiceNumber = String(
      card.order_sn || card.order_id || (cards[0] && (cards[0].order_sn || cards[0].order_id)) || '',
    ).trim();
    if (!invoiceNumber) return null;

    const lineItems = [];
    let sellerName = null;
    for (const c of cards) {
      if (!sellerName && c.shop_info && c.shop_info.shop_name) sellerName = c.shop_info.shop_name;
      const groups = (c.product_info && c.product_info.item_groups) || [];
      for (const g of groups) {
        for (const it of g.items || []) {
          const qty = toQty(it.amount ?? 1);
          const unitPrice = money(it.order_price ?? it.item_price ?? it.price_before_discount ?? 0);
          const url =
            it.shop_id && it.item_id ? `${SHOPEE_ORIGIN}/product/${it.shop_id}/${it.item_id}` : null;
          lineItems.push({
            marketplaceProductName: String(it.name || 'Unknown product').trim(),
            marketplaceProductUrl: url,
            quantity: qty,
            unitPrice: unitPrice || 0,
            subtotal: (unitPrice || 0) * qty,
          });
        }
      }
    }
    if (lineItems.length === 0) return null;

    // final_total is the amount actually paid (after vouchers/coins), so it can
    // be LOWER than the sum of line subtotals; that gap is unitemised here.
    const totalAmount =
      money(card.final_total ?? card.subtotal) || lineItems.reduce((s, li) => s + li.subtotal, 0);

    const ctime =
      detail.shipping && detail.shipping.tracking_info && detail.shipping.tracking_info.ctime;
    const orderDate = toISODate(ctime) || todayISO();

    return {
      invoiceNumber,
      orderDate,
      sellerName: sellerName || null,
      lineItems,
      shippingFee: null, // not broken out in the order-list payload
      discount: null, // voucher/coin gap is not itemised here
      totalAmount,
      detailUrl: `${SHOPEE_ORIGIN}/user/purchase/order/${invoiceNumber}`,
    };
  }

  function fromRest(responses) {
    const out = [];
    for (const { body } of responses) {
      if (!body || typeof body !== 'object') continue;
      // The order data may sit directly under `data`, or nested in
      // `data.order_data` (the get_all_order_and_checkout_list variant).
      const data = body.data || body;
      const containers = [data, data.order_data].filter((x) => x && typeof x === 'object');
      let list = null;
      for (const cnt of containers) {
        if (Array.isArray(cnt.details_list)) { list = cnt.details_list; break; }
        if (Array.isArray(cnt.order_list)) { list = cnt.order_list; break; }
      }
      if (!list) continue;
      for (const d of list) {
        const o = mapShopeeOrder(d);
        if (o) out.push(o);
      }
    }
    return dedupeOrders(out);
  }

  function fromDom(doc) {
    // Shopee's purchase DOM is heavily virtualised and class-hashed, so a DOM
    // scrape is unreliable. The REST path above is authoritative; return [] and
    // let the bridge report a parse miss rather than emit garbage.
    void doc;
    return [];
  }

  NS.parsers.shopee = function shopeeParser({ responses, document: doc }) {
    let orders = fromRest(responses || []);
    if (orders.length === 0) orders = fromDom(doc || document);
    return orders;
  };
})();

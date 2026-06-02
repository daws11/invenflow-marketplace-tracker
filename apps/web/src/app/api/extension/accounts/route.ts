// GET /api/extension/accounts — account list + scrape config for the
// home-server Chrome scraper extension. Authenticated with the extension key
// (`x-extension-key` header), NOT the NextAuth session.
//
// The extension uses this to know which marketplace purchase-list URL to open
// per account, where the resulting orders should land in InvenFlow (kanban +
// column), and what schedule to scrape on. `cronEnabled` is reported for
// reference but the extension scrapes regardless — that flag now only governs
// the (dormant) server-side Playwright worker.

import { NextResponse } from 'next/server';

import { prisma } from '@/lib/db';
import { requireExtensionKey } from '@/lib/extension-auth';

export const dynamic = 'force-dynamic';

// Default buyer purchase-list URLs per platform — kept in sync with the worker
// agents (apps/worker/src/agents/{tokopedia,shopee}.ts). An account may
// override either via `paidUrlOverride` / `shippedUrlOverride`.
// NOTE: Tokopedia IGNORES a `?status=` query on /order-list — the status filter
// is a GraphQL `Status` variable (set by the on-page tabs), not the URL. The old
// `?status=dibayar`/`?status=dikirim` defaults just loaded the full list, so we
// use the plain `/order-list` (Status="" = all; the extension dedupes by
// idempotency key). Shopee, by contrast, DOES honour `?type=` to pick the tab
// (type=2 ≈ "Sedang Dikemas"/just-paid, type=3 ≈ "Dikirim").
const DEFAULT_URLS = {
  TOKOPEDIA: {
    paid: 'https://www.tokopedia.com/order-list',
    shipped: 'https://www.tokopedia.com/order-list',
  },
  SHOPEE: {
    paid: 'https://shopee.co.id/user/purchase?type=2',
    shipped: 'https://shopee.co.id/user/purchase?type=3',
  },
} as const;

export async function GET(req: Request) {
  const unauthorized = await requireExtensionKey(req);
  if (unauthorized) return unauthorized;

  const accounts = await prisma.account.findMany({
    orderBy: { createdAt: 'desc' },
  });

  return NextResponse.json({
    accounts: accounts.map((a) => {
      const defaults = DEFAULT_URLS[a.platform];
      return {
        id: a.id,
        platform: a.platform.toLowerCase(),
        name: a.name,
        status: a.status,
        cronEnabled: a.cronEnabled,
        cronScheduleDibayar: a.cronScheduleDibayar,
        cronScheduleDikirim: a.cronScheduleDikirim,
        invenflowKanbanId: a.invenflowKanbanId,
        invenflowKanbanName: a.invenflowKanbanName,
        columnOnPaid: a.columnOnPaid,
        columnOnShipped: a.columnOnShipped,
        paidUrl: a.paidUrlOverride ?? defaults.paid,
        shippedUrl: a.shippedUrlOverride ?? defaults.shipped,
      };
    }),
  });
}

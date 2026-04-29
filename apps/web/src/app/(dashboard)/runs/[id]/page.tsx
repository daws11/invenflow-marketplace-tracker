// Run detail page (PRD §10.7).
//
// Server component fetches Run + Account + Orders (with their OrderLineItems).
// 404 if missing. The interactive bits (tabs, JSON expansion, "Retry Failed
// Syncs" button) live in the client component.

import { notFound } from 'next/navigation';

import { prisma } from '@/lib/db';
import { SETTING_KEYS, getSetting } from '@/lib/settings';

import { RunDetailClient } from './_run-detail-client';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Run · InvenFlow Marketplace Tracker' };

export default async function RunDetailPage({
  params,
}: {
  params: { id: string };
}) {
  const run = await prisma.run.findUnique({
    where: { id: params.id },
    include: {
      account: true,
      orders: {
        include: { lineItems: true },
        orderBy: { invoiceNumber: 'asc' },
      },
    },
  });
  if (!run) notFound();

  const appUrl = (await getSetting<string>(SETTING_KEYS.appUrl)) ?? '';
  const invenflowBaseUrl =
    (await getSetting<string>(SETTING_KEYS.invenflowBaseUrl)) ?? '';

  return (
    <main className="mx-auto max-w-6xl px-6 py-10">
      <RunDetailClient
        run={{
          id: run.id,
          pass: run.pass,
          status: run.status,
          triggeredBy: run.triggeredBy,
          startedAt: run.startedAt.toISOString(),
          completedAt: run.completedAt ? run.completedAt.toISOString() : null,
          errorMessage: run.errorMessage,
          modelUsed: run.modelUsed,
          orderCount: run.orderCount,
          newOrderCount: run.newOrderCount,
          transitionCount: run.transitionCount,
          failedSyncs: run.failedSyncs,
        }}
        account={{
          id: run.account.id,
          name: run.account.name,
          platform: run.account.platform,
          status: run.account.status,
        }}
        orders={run.orders.map((o) => ({
          id: o.id,
          invoiceNumber: o.invoiceNumber,
          orderDate: o.orderDate.toISOString(),
          sellerName: o.sellerName,
          totalAmount: o.totalAmount.toString(),
          rawData: o.rawData,
          lineItems: o.lineItems.map((li) => ({
            id: li.id,
            lineItemId: li.lineItemId,
            marketplaceProductName: li.marketplaceProductName,
            marketplaceProductUrl: li.marketplaceProductUrl,
            quantity: li.quantity,
            unitPrice: li.unitPrice.toString(),
            subtotal: li.subtotal.toString(),
            invenflowProductId: li.invenflowProductId,
            needsSkuMapping: li.needsSkuMapping,
            lifecycleState: li.lifecycleState,
            lastSyncError: li.lastSyncError,
            syncRetryCount: li.syncRetryCount,
            ingestedAt: li.ingestedAt ? li.ingestedAt.toISOString() : null,
            shippedAt: li.shippedAt ? li.shippedAt.toISOString() : null,
          })),
        }))}
        appUrl={appUrl}
        invenflowBaseUrl={invenflowBaseUrl}
      />
    </main>
  );
}

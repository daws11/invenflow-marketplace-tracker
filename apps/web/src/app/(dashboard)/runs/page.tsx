// Runs list page (PRD §7.10 + §10.6).
//
// Server component for the page chrome; the actual filterable + paginated
// table is a client component that fetches `/api/runs` on filter / page
// changes. This split lets us avoid SSR-fetching with every URL search-param
// change while keeping the server component for auth + account dropdown
// hydration.

import { prisma } from '@/lib/db';

import { RunsListClient } from './_runs-list-client';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Runs · InvenFlow Marketplace Tracker' };

export default async function RunsPage() {
  const accounts = await prisma.account.findMany({
    select: { id: true, name: true, platform: true },
    orderBy: { name: 'asc' },
  });

  return (
    <main className="mx-auto max-w-6xl px-6 py-10">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight text-neutral-900">
          Runs
        </h1>
        <p className="mt-1 text-sm text-neutral-600">
          Every scheduled and manual scrape pass is recorded here. Click a row
          to see the orders, line items, and sync state for that run.
        </p>
      </header>

      <RunsListClient accounts={accounts} />
    </main>
  );
}

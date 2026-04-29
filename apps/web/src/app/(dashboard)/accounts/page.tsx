// Accounts list page (PRD §10.3 / §10.4).
//
// Server component that loads the rows from Prisma, then hands them to a
// client component which owns the row-level actions (delete confirm flow,
// future "Open Browser" trigger). We deliberately don't include Run-derived
// columns yet (last run timestamp, run count) — that lives in C5; today the
// table mirrors the shape of `Account` only.

import Link from 'next/link';

import { prisma } from '@/lib/db';

import { AccountListClient } from './_list-client';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Accounts · InvenFlow Marketplace Tracker' };

export default async function AccountsPage() {
  const accounts = await prisma.account.findMany({
    orderBy: { createdAt: 'desc' },
  });

  return (
    <main className="mx-auto max-w-6xl px-6 py-10">
      <header className="mb-6 flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-neutral-900">
            Accounts
          </h1>
          <p className="mt-1 text-sm text-neutral-600">
            Marketplace logins this sidecar tracks. Each account scrapes a
            single Tokopedia or Shopee buyer dashboard.
          </p>
        </div>
        <Link
          href="/accounts/new"
          className="inline-flex items-center justify-center rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-neutral-800 focus:outline-none focus:ring-2 focus:ring-neutral-500 focus:ring-offset-2"
        >
          + Add Account
        </Link>
      </header>

      <AccountListClient
        accounts={accounts.map((a) => ({
          id: a.id,
          name: a.name,
          platform: a.platform,
          status: a.status,
          lastLoginAt: a.lastLoginAt ? a.lastLoginAt.toISOString() : null,
          invenflowKanbanName: a.invenflowKanbanName,
          columnOnPaid: a.columnOnPaid,
          columnOnShipped: a.columnOnShipped,
          cronEnabled: a.cronEnabled,
          cronScheduleDibayar: a.cronScheduleDibayar,
          cronScheduleDikirim: a.cronScheduleDikirim,
        }))}
      />
    </main>
  );
}

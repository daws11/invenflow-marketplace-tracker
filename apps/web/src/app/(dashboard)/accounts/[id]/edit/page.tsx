// /accounts/[id]/edit — server-loaded prefill, then client-side form.

import { notFound } from 'next/navigation';

import { prisma } from '@/lib/db';

import { EditAccountClient } from './edit-client';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Edit account · InvenFlow Marketplace Tracker' };

export default async function EditAccountPage({
  params,
}: {
  params: { id: string };
}) {
  const account = await prisma.account.findUnique({
    where: { id: params.id },
  });
  if (!account) notFound();

  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight text-neutral-900">
          Edit account
        </h1>
        <p className="mt-1 text-sm text-neutral-600">
          Update target kanban, column mappings, schedule, and overrides.
          Platform is fixed once an account exists.
        </p>
      </header>

      <EditAccountClient
        accountId={account.id}
        initial={{
          name: account.name,
          platform: account.platform,
          invenflowKanbanId: account.invenflowKanbanId,
          invenflowKanbanName: account.invenflowKanbanName,
          columnOnPaid: account.columnOnPaid,
          columnOnShipped: account.columnOnShipped,
          cronEnabled: account.cronEnabled,
          cronScheduleDibayar: account.cronScheduleDibayar,
          cronScheduleDikirim: account.cronScheduleDikirim,
          paidUrlOverride: account.paidUrlOverride ?? '',
          shippedUrlOverride: account.shippedUrlOverride ?? '',
          notes: account.notes ?? '',
        }}
      />
    </main>
  );
}

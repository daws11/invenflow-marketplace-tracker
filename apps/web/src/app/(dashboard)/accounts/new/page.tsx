'use client';

// /accounts/new — create form. PRD §7.2.2 Add Account wizard.
//
// Uses the shared <AccountForm> in `create` mode. Submitting POSTs to
// /api/accounts and on success redirects to /accounts.

import { useRouter } from 'next/navigation';

import { AccountForm, type AccountFormValues } from '../_account-form';

export default function NewAccountPage() {
  const router = useRouter();

  async function handleSubmit(values: AccountFormValues): Promise<void> {
    const res = await fetch('/api/accounts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(toPayload(values)),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      const msg =
        typeof (data as { error?: unknown }).error === 'string'
          ? (data as { error: string }).error
          : `Failed to create account (${res.status})`;
      throw new Error(msg);
    }
    router.push('/accounts');
    router.refresh();
  }

  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight text-neutral-900">
          Add account
        </h1>
        <p className="mt-1 text-sm text-neutral-600">
          Connect a Tokopedia or Shopee buyer dashboard to an InvenFlow kanban.
          You can launch a browser session to log in after the account is
          created.
        </p>
      </header>

      <AccountForm mode="create" onSubmit={handleSubmit} />
    </main>
  );
}

// Trim whitespace and drop empty optional strings so we don't send empty-string
// URLs (they'd fail Zod's url() check on the server).
function toPayload(v: AccountFormValues): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    name: v.name.trim(),
    platform: v.platform,
    invenflowKanbanId: v.invenflowKanbanId,
    invenflowKanbanName: v.invenflowKanbanName,
    columnOnPaid: v.columnOnPaid,
    columnOnShipped: v.columnOnShipped,
    cronEnabled: v.cronEnabled,
    cronScheduleDibayar: v.cronScheduleDibayar.trim(),
    cronScheduleDikirim: v.cronScheduleDikirim.trim(),
  };
  if (v.paidUrlOverride.trim()) payload.paidUrlOverride = v.paidUrlOverride.trim();
  if (v.shippedUrlOverride.trim())
    payload.shippedUrlOverride = v.shippedUrlOverride.trim();
  if (v.notes.trim()) payload.notes = v.notes.trim();
  return payload;
}

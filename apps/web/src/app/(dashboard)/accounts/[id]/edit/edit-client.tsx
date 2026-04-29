'use client';

// Client wrapper for the edit form. Builds the PATCH payload from the
// changed values; sends only fields that the schema permits to mutate
// (platform is fixed, status/lastLoginAt are owned by the C2b login flow).

import { useRouter } from 'next/navigation';

import { AccountForm, type AccountFormValues } from '../../_account-form';

export function EditAccountClient({
  accountId,
  initial,
}: {
  accountId: string;
  initial: AccountFormValues;
}) {
  const router = useRouter();

  async function onSubmit(values: AccountFormValues): Promise<void> {
    const res = await fetch(`/api/accounts/${accountId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(toPayload(values)),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      const msg =
        typeof (data as { error?: unknown }).error === 'string'
          ? (data as { error: string }).error
          : `Failed to save (${res.status})`;
      throw new Error(msg);
    }
    router.push('/accounts');
    router.refresh();
  }

  return (
    <AccountForm mode="edit" initialValues={initial} onSubmit={onSubmit} />
  );
}

// PATCH payload: convert empty optional strings to `null` so the server
// clears the column. Trim every text field. Skip platform — the route
// schema rejects it on PATCH anyway.
function toPayload(v: AccountFormValues): Record<string, unknown> {
  return {
    name: v.name.trim(),
    invenflowKanbanId: v.invenflowKanbanId,
    invenflowKanbanName: v.invenflowKanbanName,
    columnOnPaid: v.columnOnPaid,
    columnOnShipped: v.columnOnShipped,
    cronEnabled: v.cronEnabled,
    cronScheduleDibayar: v.cronScheduleDibayar.trim(),
    cronScheduleDikirim: v.cronScheduleDikirim.trim(),
    paidUrlOverride: v.paidUrlOverride.trim() ? v.paidUrlOverride.trim() : null,
    shippedUrlOverride: v.shippedUrlOverride.trim()
      ? v.shippedUrlOverride.trim()
      : null,
    notes: v.notes.trim() ? v.notes.trim() : null,
  };
}

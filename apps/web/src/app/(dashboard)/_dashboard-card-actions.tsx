'use client';

// Per-account "Run Now" actions on the dashboard. POSTs to the manual-trigger
// endpoint and navigates to the new run's detail page on success.

import { useState } from 'react';

export function DashboardCardActions({ accountId }: { accountId: string }) {
  const [busy, setBusy] = useState<'paid' | 'shipped' | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function trigger(kind: 'paid' | 'shipped') {
    setBusy(kind);
    setError(null);
    try {
      const res = await fetch(`/api/accounts/${accountId}/runs/${kind}`, {
        method: 'POST',
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(
          (body && typeof body === 'object' && 'error' in body
            ? String((body as { error?: unknown }).error)
            : null) ?? `Failed (${res.status})`,
        );
      }
      const data = (await res.json()) as { runId?: string };
      if (data.runId) {
        window.location.href = `/runs/${data.runId}`;
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => trigger('paid')}
        disabled={busy !== null}
        className="inline-flex items-center justify-center rounded-md border border-neutral-300 bg-white px-2.5 py-1 text-xs font-medium text-neutral-700 shadow-sm transition hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {busy === 'paid' ? 'Triggering…' : 'Run paid'}
      </button>
      <button
        type="button"
        onClick={() => trigger('shipped')}
        disabled={busy !== null}
        className="inline-flex items-center justify-center rounded-md border border-neutral-300 bg-white px-2.5 py-1 text-xs font-medium text-neutral-700 shadow-sm transition hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {busy === 'shipped' ? 'Triggering…' : 'Run shipped'}
      </button>
      {error ? (
        <span className="block text-xs text-red-600">{error}</span>
      ) : null}
    </>
  );
}

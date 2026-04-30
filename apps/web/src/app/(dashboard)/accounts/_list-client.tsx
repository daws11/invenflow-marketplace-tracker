'use client';

// Client-side renderer for the accounts table. Owns:
//   - per-row "Delete" with a native confirm dialog (room for a nicer modal
//     later when we have shared UI primitives);
//   - "Open Browser" link (C2b — opens an interactive Chromium session
//     proxied through noVNC at /accounts/[id]/browser); disabled only for
//     accounts in ERROR status (operator should re-create or troubleshoot
//     before launching a session);
//   - "Edit" link.
// The server component handles initial rendering; we re-fetch via
// router.refresh() after a delete so the row disappears without a full page
// reload.

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import type { AccountStatus, Platform } from '@prisma/client';

import { CronCell, PlatformBadge, StatusBadge } from './_account-helpers';

export interface AccountRow {
  id: string;
  name: string;
  platform: Platform;
  status: AccountStatus;
  lastLoginAt: string | null;
  invenflowKanbanName: string;
  columnOnPaid: string;
  columnOnShipped: string;
  cronEnabled: boolean;
  cronScheduleDibayar: string;
  cronScheduleDikirim: string;
}

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

export function AccountListClient({ accounts }: { accounts: AccountRow[] }) {
  const router = useRouter();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function onDelete(row: AccountRow) {
    const ok = window.confirm(
      `Delete account "${row.name}"? This removes the local profile directory and any saved cookies. Runs and orders previously synced to InvenFlow are not touched.`,
    );
    if (!ok) return;

    setBusyId(row.id);
    setError(null);
    try {
      const res = await fetch(`/api/accounts/${row.id}`, {
        method: 'DELETE',
      });
      if (!res.ok && res.status !== 204) {
        const data = await res.json().catch(() => ({}));
        throw new Error(
          (data && typeof data === 'object' && 'error' in data
            ? String((data as { error: unknown }).error)
            : null) ?? `Delete failed (${res.status})`,
        );
      }
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusyId(null);
    }
  }

  if (accounts.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-neutral-300 bg-white p-10 text-center">
        <p className="text-sm text-neutral-600">
          No accounts yet. Click <strong>&ldquo;Add Account&rdquo;</strong> to get
          started.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {error ? (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
          {error}
        </div>
      ) : null}

      <div className="overflow-hidden rounded-lg border border-neutral-200 bg-white shadow-sm">
        <table className="min-w-full divide-y divide-neutral-200 text-sm">
          <thead className="bg-neutral-50 text-left text-xs uppercase tracking-wide text-neutral-500">
            <tr>
              <th scope="col" className="px-4 py-3">Platform</th>
              <th scope="col" className="px-4 py-3">Name</th>
              <th scope="col" className="px-4 py-3">Status</th>
              <th scope="col" className="px-4 py-3">Last Login</th>
              <th scope="col" className="px-4 py-3">Kanban</th>
              <th scope="col" className="px-4 py-3">Columns</th>
              <th scope="col" className="px-4 py-3">Cron</th>
              <th scope="col" className="px-4 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-100">
            {accounts.map((row) => {
              const busy = busyId === row.id;
              return (
                <tr key={row.id} className="hover:bg-neutral-50">
                  <td className="px-4 py-3">
                    <PlatformBadge platform={row.platform} />
                  </td>
                  <td className="px-4 py-3 font-medium text-neutral-900">
                    {row.name}
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge status={row.status} />
                  </td>
                  <td className="px-4 py-3 text-neutral-600">
                    {formatDate(row.lastLoginAt)}
                  </td>
                  <td className="px-4 py-3 text-neutral-700">
                    {row.invenflowKanbanName}
                  </td>
                  <td className="px-4 py-3 text-neutral-600">
                    <span className="rounded bg-neutral-100 px-1.5 py-0.5 font-mono text-xs">
                      {row.columnOnPaid}
                    </span>
                    <span className="mx-1 text-neutral-400">→</span>
                    <span className="rounded bg-neutral-100 px-1.5 py-0.5 font-mono text-xs">
                      {row.columnOnShipped}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <CronCell
                      enabled={row.cronEnabled}
                      paid={row.cronScheduleDibayar}
                      shipped={row.cronScheduleDikirim}
                    />
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex justify-end gap-2">
                      {row.status === 'ERROR' ? (
                        <button
                          type="button"
                          disabled
                          title="Account is in ERROR; resolve the underlying issue before opening a session."
                          className="inline-flex items-center justify-center rounded-md border border-neutral-300 bg-white px-2.5 py-1 text-xs font-medium text-neutral-400 shadow-sm"
                        >
                          Open Browser
                        </button>
                      ) : (
                        <Link
                          href={`/accounts/${row.id}/browser`}
                          className="inline-flex items-center justify-center rounded-md border border-neutral-300 bg-white px-2.5 py-1 text-xs font-medium text-neutral-700 shadow-sm transition hover:bg-neutral-50"
                        >
                          Open Browser
                        </Link>
                      )}
                      <Link
                        href={`/accounts/${row.id}/edit`}
                        className="inline-flex items-center justify-center rounded-md border border-neutral-300 bg-white px-2.5 py-1 text-xs font-medium text-neutral-700 shadow-sm transition hover:bg-neutral-50"
                      >
                        Edit
                      </Link>
                      <button
                        type="button"
                        onClick={() => onDelete(row)}
                        disabled={busy}
                        className="inline-flex items-center justify-center rounded-md border border-red-300 bg-white px-2.5 py-1 text-xs font-medium text-red-700 shadow-sm transition hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        {busy ? 'Deleting…' : 'Delete'}
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

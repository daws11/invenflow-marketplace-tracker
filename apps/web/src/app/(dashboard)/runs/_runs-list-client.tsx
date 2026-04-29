'use client';

// Runs list — client component owning filters, pagination, and the table.

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';

import type { Platform, RunPass, RunStatus, TriggerType } from '@prisma/client';

interface AccountOption {
  id: string;
  name: string;
  platform: Platform;
}

interface RunRow {
  id: string;
  accountId: string;
  account: { id: string; name: string; platform: Platform };
  pass: RunPass;
  status: RunStatus;
  triggeredBy: TriggerType;
  startedAt: string;
  completedAt: string | null;
  errorMessage: string | null;
  modelUsed: string | null;
  orderCount: number;
  newOrderCount: number;
  transitionCount: number;
  failedSyncs: number;
}

interface Filters {
  account: string;
  pass: '' | RunPass;
  status: '' | RunStatus;
  from: string; // YYYY-MM-DD
  to: string;   // YYYY-MM-DD
}

const PAGE_SIZE = 20;

function defaultFromDate(): string {
  const d = new Date();
  d.setDate(d.getDate() - 7);
  return d.toISOString().slice(0, 10);
}

function defaultToDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function formatTimestamp(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function formatDuration(startIso: string, endIso: string | null): string {
  if (!endIso) return 'running…';
  const ms = new Date(endIso).getTime() - new Date(startIso).getTime();
  if (Number.isNaN(ms) || ms < 0) return '—';
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const rem = sec % 60;
  return `${min}m ${rem}s`;
}

function PlatformChip({ platform }: { platform: Platform }) {
  const palette =
    platform === 'TOKOPEDIA'
      ? 'bg-green-100 text-green-800'
      : 'bg-orange-100 text-orange-800';
  return (
    <span
      className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${palette}`}
    >
      {platform === 'TOKOPEDIA' ? 'T' : 'S'}
    </span>
  );
}

function PassBadge({ pass }: { pass: RunPass }) {
  const palette: Record<RunPass, string> = {
    PAID: 'bg-blue-100 text-blue-800',
    SHIPPED: 'bg-purple-100 text-purple-800',
    LOGIN: 'bg-neutral-200 text-neutral-700',
  };
  return (
    <span
      className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${palette[pass]}`}
    >
      {pass}
    </span>
  );
}

function StatusBadge({ status }: { status: RunStatus }) {
  const palette: Record<RunStatus, string> = {
    PENDING: 'bg-neutral-200 text-neutral-700',
    RUNNING: 'bg-blue-100 text-blue-800',
    SUCCESS: 'bg-green-100 text-green-800',
    FAILED: 'bg-red-100 text-red-800',
    CANCELED: 'bg-yellow-100 text-yellow-800',
  };
  return (
    <span
      className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${palette[status]}`}
    >
      {status}
    </span>
  );
}

export function RunsListClient({ accounts }: { accounts: AccountOption[] }) {
  const [filters, setFilters] = useState<Filters>({
    account: '',
    pass: '',
    status: '',
    from: defaultFromDate(),
    to: defaultToDate(),
  });
  const [page, setPage] = useState(1);
  const [data, setData] = useState<{ runs: RunRow[]; total: number } | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const totalPages = useMemo(
    () => (data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1),
    [data],
  );

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      setError(null);
      const params = new URLSearchParams();
      if (filters.account) params.set('account', filters.account);
      if (filters.pass) params.set('pass', filters.pass);
      if (filters.status) params.set('status', filters.status);
      if (filters.from) {
        params.set('from', new Date(`${filters.from}T00:00:00Z`).toISOString());
      }
      if (filters.to) {
        params.set('to', new Date(`${filters.to}T23:59:59Z`).toISOString());
      }
      params.set('page', String(page));
      params.set('pageSize', String(PAGE_SIZE));

      try {
        const res = await fetch(`/api/runs?${params.toString()}`);
        if (!res.ok) throw new Error(`Failed (${res.status})`);
        const json = (await res.json()) as { runs: RunRow[]; total: number };
        if (!cancelled) setData(json);
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [filters, page]);

  // Reset to page 1 when filters change.
  useEffect(() => {
    setPage(1);
  }, [filters.account, filters.pass, filters.status, filters.from, filters.to]);

  return (
    <div className="space-y-4">
      {/* Filters */}
      <div className="rounded-lg border border-neutral-200 bg-white p-4 shadow-sm">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-5">
          <label className="text-sm">
            <span className="block text-xs font-medium text-neutral-600">
              Account
            </span>
            <select
              className="mt-1 block w-full rounded-md border border-neutral-300 px-2 py-1.5 text-sm"
              value={filters.account}
              onChange={(e) =>
                setFilters((f) => ({ ...f, account: e.target.value }))
              }
            >
              <option value="">All accounts</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} ({a.platform === 'TOKOPEDIA' ? 'Tokopedia' : 'Shopee'})
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            <span className="block text-xs font-medium text-neutral-600">
              Pass
            </span>
            <select
              className="mt-1 block w-full rounded-md border border-neutral-300 px-2 py-1.5 text-sm"
              value={filters.pass}
              onChange={(e) =>
                setFilters((f) => ({
                  ...f,
                  pass: e.target.value as Filters['pass'],
                }))
              }
            >
              <option value="">All</option>
              <option value="PAID">Paid</option>
              <option value="SHIPPED">Shipped</option>
              <option value="LOGIN">Login</option>
            </select>
          </label>
          <label className="text-sm">
            <span className="block text-xs font-medium text-neutral-600">
              Status
            </span>
            <select
              className="mt-1 block w-full rounded-md border border-neutral-300 px-2 py-1.5 text-sm"
              value={filters.status}
              onChange={(e) =>
                setFilters((f) => ({
                  ...f,
                  status: e.target.value as Filters['status'],
                }))
              }
            >
              <option value="">All</option>
              <option value="PENDING">Pending</option>
              <option value="RUNNING">Running</option>
              <option value="SUCCESS">Success</option>
              <option value="FAILED">Failed</option>
              <option value="CANCELED">Canceled</option>
            </select>
          </label>
          <label className="text-sm">
            <span className="block text-xs font-medium text-neutral-600">
              From
            </span>
            <input
              type="date"
              className="mt-1 block w-full rounded-md border border-neutral-300 px-2 py-1.5 text-sm"
              value={filters.from}
              onChange={(e) =>
                setFilters((f) => ({ ...f, from: e.target.value }))
              }
            />
          </label>
          <label className="text-sm">
            <span className="block text-xs font-medium text-neutral-600">
              To
            </span>
            <input
              type="date"
              className="mt-1 block w-full rounded-md border border-neutral-300 px-2 py-1.5 text-sm"
              value={filters.to}
              onChange={(e) =>
                setFilters((f) => ({ ...f, to: e.target.value }))
              }
            />
          </label>
        </div>
      </div>

      {/* Table */}
      {error ? (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
          {error}
        </div>
      ) : null}

      {loading && !data ? (
        <SkeletonTable />
      ) : !data || data.runs.length === 0 ? (
        <div className="rounded-lg border border-dashed border-neutral-300 bg-white p-10 text-center">
          <p className="text-sm text-neutral-600">
            No runs match the current filters.
          </p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-neutral-200 bg-white shadow-sm">
          <table className="min-w-full divide-y divide-neutral-200 text-sm">
            <thead className="bg-neutral-50 text-left text-xs uppercase tracking-wide text-neutral-500">
              <tr>
                <th scope="col" className="px-4 py-3">Started</th>
                <th scope="col" className="px-4 py-3">Account</th>
                <th scope="col" className="px-4 py-3">Pass</th>
                <th scope="col" className="px-4 py-3">Status</th>
                <th scope="col" className="px-4 py-3">Trigger</th>
                <th scope="col" className="px-4 py-3">Duration</th>
                <th scope="col" className="px-4 py-3">Counts</th>
                <th scope="col" className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100">
              {data.runs.map((r) => (
                <tr key={r.id} className="hover:bg-neutral-50">
                  <td className="whitespace-nowrap px-4 py-3 font-mono text-xs text-neutral-700">
                    {formatTimestamp(r.startedAt)}
                  </td>
                  <td className="px-4 py-3">
                    <span className="inline-flex items-center gap-1.5">
                      <PlatformChip platform={r.account.platform} />
                      <span>{r.account.name}</span>
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <PassBadge pass={r.pass} />
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge status={r.status} />
                  </td>
                  <td className="px-4 py-3 text-xs text-neutral-600">
                    {r.triggeredBy.toLowerCase()}
                  </td>
                  <td className="px-4 py-3 text-neutral-700">
                    {formatDuration(r.startedAt, r.completedAt)}
                  </td>
                  <td className="px-4 py-3 text-xs text-neutral-700">
                    {r.pass === 'PAID' ? (
                      <>
                        {r.orderCount} orders ·{' '}
                        <strong>{r.newOrderCount} new</strong>
                      </>
                    ) : r.pass === 'SHIPPED' ? (
                      <>
                        {r.transitionCount} transitioned ·{' '}
                        {r.failedSyncs > 0 ? (
                          <span className="text-red-600">
                            {r.failedSyncs} failed
                          </span>
                        ) : (
                          '0 failed'
                        )}
                      </>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <Link
                      href={`/runs/${r.id}`}
                      className="text-sm font-medium text-blue-600 hover:underline"
                    >
                      View →
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Pagination */}
      {data && data.total > PAGE_SIZE ? (
        <div className="flex items-center justify-between text-sm text-neutral-600">
          <span>
            Page {page} of {totalPages} · {data.total} total
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={page <= 1 || loading}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              className="rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-sm shadow-sm transition hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              ← Prev
            </button>
            <button
              type="button"
              disabled={page >= totalPages || loading}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              className="rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-sm shadow-sm transition hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Next →
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function SkeletonTable() {
  return (
    <div className="overflow-hidden rounded-lg border border-neutral-200 bg-white shadow-sm">
      <div className="animate-pulse space-y-3 p-4">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="h-4 rounded bg-neutral-100" />
        ))}
      </div>
    </div>
  );
}

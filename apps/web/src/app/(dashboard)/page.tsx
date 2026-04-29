// Dashboard root (PRD §10.2).
//
// Server component renders:
//   - Header with last-updated timestamp.
//   - Account cards (one per Account row), each with a "Run Now" split button
//     (paid / shipped) and an "Open Browser" link.
//   - Recent runs (last 5 across all accounts).
//   - Quick stats (3 cards: runs this week, orders ingested this month,
//     failed syncs awaiting attention).
//   - Empty state when there are no accounts.

import Link from 'next/link';

import { prisma } from '@/lib/db';

import { DashboardCardActions } from './_dashboard-card-actions';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Dashboard · InvenFlow Marketplace Tracker' };

function startOfWeek(): Date {
  const d = new Date();
  // Last 7 days, rolling.
  d.setDate(d.getDate() - 7);
  return d;
}

function startOfMonth(): Date {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

function formatTimestamp(iso: Date | null): string {
  if (!iso) return '—';
  try {
    return iso.toLocaleString();
  } catch {
    return iso.toISOString();
  }
}

function PlatformChip({ platform }: { platform: 'TOKOPEDIA' | 'SHOPEE' }) {
  const palette =
    platform === 'TOKOPEDIA'
      ? 'bg-green-100 text-green-800'
      : 'bg-orange-100 text-orange-800';
  return (
    <span
      className={`inline-flex h-6 w-6 items-center justify-center rounded-md text-xs font-bold ${palette}`}
    >
      {platform === 'TOKOPEDIA' ? 'T' : 'S'}
    </span>
  );
}

function StatusBadge({
  status,
}: {
  status: 'NOT_LOGGED_IN' | 'LOGGED_IN' | 'SESSION_EXPIRED' | 'ERROR';
}) {
  const palette = {
    NOT_LOGGED_IN: 'bg-neutral-200 text-neutral-700',
    LOGGED_IN: 'bg-green-100 text-green-800',
    SESSION_EXPIRED: 'bg-yellow-100 text-yellow-800',
    ERROR: 'bg-red-100 text-red-800',
  } as const;
  const label = {
    NOT_LOGGED_IN: 'Not logged in',
    LOGGED_IN: 'Logged in',
    SESSION_EXPIRED: 'Session expired',
    ERROR: 'Error',
  } as const;
  return (
    <span
      className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${palette[status]}`}
    >
      {label[status]}
    </span>
  );
}

export default async function DashboardHomePage() {
  const [
    accounts,
    recentRuns,
    runsThisWeek,
    ingestedThisMonth,
    failedSyncs,
  ] = await Promise.all([
    prisma.account.findMany({ orderBy: { createdAt: 'desc' } }),
    prisma.run.findMany({
      orderBy: { startedAt: 'desc' },
      take: 5,
      include: {
        account: { select: { id: true, name: true, platform: true } },
      },
    }),
    prisma.run.count({ where: { startedAt: { gte: startOfWeek() } } }),
    prisma.orderLineItem.count({
      where: { ingestedAt: { gte: startOfMonth() } },
    }),
    prisma.orderLineItem.count({
      where: { lifecycleState: 'SYNC_FAILED' },
    }),
  ]);

  const lastUpdated = new Date();

  return (
    <main className="mx-auto max-w-6xl px-6 py-10">
      <header className="mb-6 flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-neutral-900">
            Marketplace Tracker — Dashboard
          </h1>
          <p className="mt-1 text-sm text-neutral-600">
            Overview of marketplace accounts, recent runs, and pending issues.
          </p>
        </div>
        <div className="text-xs text-neutral-500">
          Last updated:{' '}
          <span className="font-mono">{formatTimestamp(lastUpdated)}</span>
        </div>
      </header>

      {/* Quick stats */}
      <section className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatCard label="Runs this week" value={runsThisWeek} />
        <StatCard
          label="Orders ingested this month"
          value={ingestedThisMonth}
        />
        <StatCard
          label="Failed syncs"
          value={failedSyncs}
          tone={failedSyncs > 0 ? 'red' : 'neutral'}
          link={failedSyncs > 0 ? '/runs?status=FAILED' : undefined}
        />
      </section>

      {/* Accounts */}
      <section className="mb-8">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-base font-semibold text-neutral-900">
            Accounts
          </h2>
          <Link
            href="/accounts"
            className="text-xs text-blue-600 hover:underline"
          >
            Manage all →
          </Link>
        </div>

        {accounts.length === 0 ? (
          <div className="rounded-lg border border-dashed border-neutral-300 bg-white p-10 text-center">
            <p className="text-sm text-neutral-600">
              No accounts yet. Add one to get started.
            </p>
            <Link
              href="/accounts/new"
              className="mt-3 inline-flex items-center justify-center rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-neutral-800"
            >
              + Add Account
            </Link>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
            {accounts.map((a) => (
              <article
                key={a.id}
                className="rounded-lg border border-neutral-200 bg-white p-4 shadow-sm"
              >
                <div className="mb-2 flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <PlatformChip platform={a.platform} />
                    <h3 className="font-medium text-neutral-900">{a.name}</h3>
                  </div>
                  <StatusBadge status={a.status} />
                </div>
                <dl className="space-y-1 text-xs text-neutral-600">
                  <div>
                    <span className="text-neutral-500">Last login:</span>{' '}
                    <span className="font-mono text-neutral-700">
                      {formatTimestamp(a.lastLoginAt)}
                    </span>
                  </div>
                  <div>
                    <span className="text-neutral-500">Kanban:</span>{' '}
                    <span className="text-neutral-700">
                      {a.invenflowKanbanName}
                    </span>
                  </div>
                  <div>
                    <span className="text-neutral-500">Columns:</span>{' '}
                    <code className="rounded bg-neutral-100 px-1 py-0.5 font-mono">
                      {a.columnOnPaid}
                    </code>{' '}
                    →{' '}
                    <code className="rounded bg-neutral-100 px-1 py-0.5 font-mono">
                      {a.columnOnShipped}
                    </code>
                  </div>
                </dl>

                <div className="mt-3 flex flex-wrap gap-2">
                  <DashboardCardActions accountId={a.id} />
                  <Link
                    href={`/accounts/${a.id}/browser`}
                    className="inline-flex items-center justify-center rounded-md border border-neutral-300 bg-white px-2.5 py-1 text-xs font-medium text-neutral-700 shadow-sm transition hover:bg-neutral-50"
                  >
                    Open Browser
                  </Link>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      {/* Recent runs */}
      <section>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-base font-semibold text-neutral-900">
            Recent runs
          </h2>
          <Link
            href="/runs"
            className="text-xs text-blue-600 hover:underline"
          >
            View all →
          </Link>
        </div>
        {recentRuns.length === 0 ? (
          <div className="rounded-lg border border-dashed border-neutral-300 bg-white p-6 text-center text-sm text-neutral-600">
            No runs yet.
          </div>
        ) : (
          <div className="overflow-hidden rounded-lg border border-neutral-200 bg-white shadow-sm">
            <table className="min-w-full divide-y divide-neutral-200 text-sm">
              <thead className="bg-neutral-50 text-left text-xs uppercase tracking-wide text-neutral-500">
                <tr>
                  <th className="px-4 py-2.5">Started</th>
                  <th className="px-4 py-2.5">Account</th>
                  <th className="px-4 py-2.5">Pass</th>
                  <th className="px-4 py-2.5">Status</th>
                  <th className="px-4 py-2.5">Counts</th>
                  <th className="px-4 py-2.5 text-right" />
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100">
                {recentRuns.map((r) => (
                  <tr key={r.id} className="hover:bg-neutral-50">
                    <td className="whitespace-nowrap px-4 py-2 font-mono text-xs text-neutral-700">
                      {formatTimestamp(r.startedAt)}
                    </td>
                    <td className="px-4 py-2">
                      <span className="inline-flex items-center gap-1.5">
                        <PlatformChip platform={r.account.platform} />
                        <span>{r.account.name}</span>
                      </span>
                    </td>
                    <td className="px-4 py-2 text-xs">{r.pass}</td>
                    <td className="px-4 py-2 text-xs">{r.status}</td>
                    <td className="px-4 py-2 text-xs text-neutral-700">
                      {r.pass === 'PAID'
                        ? `${r.orderCount} orders / ${r.newOrderCount} new`
                        : r.pass === 'SHIPPED'
                          ? `${r.transitionCount} transitioned${
                              r.failedSyncs > 0
                                ? ` · ${r.failedSyncs} failed`
                                : ''
                            }`
                          : '—'}
                    </td>
                    <td className="px-4 py-2 text-right">
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
      </section>
    </main>
  );
}

function StatCard({
  label,
  value,
  tone = 'neutral',
  link,
}: {
  label: string;
  value: number;
  tone?: 'neutral' | 'red';
  link?: string;
}) {
  const colour = tone === 'red' ? 'text-red-700' : 'text-neutral-900';
  const inner = (
    <>
      <div className="text-xs uppercase tracking-wide text-neutral-500">
        {label}
      </div>
      <div className={`mt-1 text-2xl font-semibold ${colour}`}>{value}</div>
    </>
  );
  return link ? (
    <Link
      href={link}
      className="rounded-lg border border-neutral-200 bg-white p-4 shadow-sm transition hover:border-neutral-300"
    >
      {inner}
    </Link>
  ) : (
    <div className="rounded-lg border border-neutral-200 bg-white p-4 shadow-sm">
      {inner}
    </div>
  );
}

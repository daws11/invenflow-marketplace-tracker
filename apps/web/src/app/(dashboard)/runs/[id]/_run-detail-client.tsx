'use client';

// Run detail client — owns tab state, polling for in-progress runs, the
// "Retry Failed Syncs" action, and the per-line raw-data expansion.
//
// Polling: when the run is PENDING or RUNNING we re-fetch the page state via
// router.refresh() every 2s (PRD allows polling per the C5 brief — no SSE).

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

import type {
  AccountStatus,
  LifecycleState,
  Platform,
  RunPass,
  RunStatus,
  TriggerType,
} from '@prisma/client';

interface RunSummary {
  id: string;
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

interface AccountSummary {
  id: string;
  name: string;
  platform: Platform;
  status: AccountStatus;
}

interface LineItem {
  id: string;
  lineItemId: string;
  marketplaceProductName: string;
  marketplaceProductUrl: string | null;
  quantity: number;
  unitPrice: string;
  subtotal: string;
  invenflowProductId: string | null;
  needsSkuMapping: boolean;
  lifecycleState: LifecycleState;
  lastSyncError: string | null;
  syncRetryCount: number;
  ingestedAt: string | null;
  shippedAt: string | null;
}

interface OrderRow {
  id: string;
  invoiceNumber: string;
  orderDate: string;
  sellerName: string | null;
  totalAmount: string;
  rawData: unknown;
  lineItems: LineItem[];
}

const POLL_MS = 2000;

function formatRupiah(value: string): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return value;
  return new Intl.NumberFormat('id-ID', {
    style: 'currency',
    currency: 'IDR',
    maximumFractionDigits: 0,
  }).format(n);
}

function formatTimestamp(iso: string | null): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
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

function LifecycleBadge({ state }: { state: LifecycleState }) {
  const palette: Record<LifecycleState, string> = {
    NEW: 'bg-neutral-200 text-neutral-700',
    INGESTED: 'bg-blue-100 text-blue-800',
    SHIPPED_CONFIRMED: 'bg-green-100 text-green-800',
    SHIPPED_BUT_OPERATOR_MOVED: 'bg-yellow-100 text-yellow-800',
    SYNC_FAILED: 'bg-red-100 text-red-800',
  };
  const label: Record<LifecycleState, string> = {
    NEW: 'New',
    INGESTED: 'Ingested',
    SHIPPED_CONFIRMED: 'Shipped',
    SHIPPED_BUT_OPERATOR_MOVED: 'Operator moved',
    SYNC_FAILED: 'Sync failed',
  };
  return (
    <span
      className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${palette[state]}`}
    >
      {label[state]}
    </span>
  );
}

type Tab = 'orders' | 'raw';

export function RunDetailClient(props: {
  run: RunSummary;
  account: AccountSummary;
  orders: OrderRow[];
  appUrl: string;
  invenflowBaseUrl: string;
}) {
  const { run, account, orders, invenflowBaseUrl } = props;
  const router = useRouter();
  const [tab, setTab] = useState<Tab>('orders');
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  const [retryNotice, setRetryNotice] = useState<string | null>(null);

  const isInProgress = run.status === 'PENDING' || run.status === 'RUNNING';

  // Poll while the run is in-progress so the operator sees status flips.
  useEffect(() => {
    if (!isInProgress) return;
    const t = setInterval(() => {
      router.refresh();
    }, POLL_MS);
    return () => clearInterval(t);
  }, [isInProgress, router]);

  const failedLines = orders
    .flatMap((o) => o.lineItems)
    .filter((li) => li.lifecycleState === 'SYNC_FAILED');

  async function onRetryFailed() {
    setRetrying(true);
    setRetryError(null);
    setRetryNotice(null);
    try {
      const res = await fetch(
        `/api/accounts/${account.id}/runs/shipped`,
        { method: 'POST' },
      );
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
        setRetryNotice('Retry triggered. Redirecting…');
        // Send the operator to the new run's detail page.
        window.location.href = `/runs/${data.runId}`;
      } else {
        setRetryNotice('Retry queued.');
      }
    } catch (err) {
      setRetryError((err as Error).message);
    } finally {
      setRetrying(false);
    }
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="rounded-lg border border-neutral-200 bg-white p-5 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <Link
              href="/runs"
              className="text-xs text-neutral-500 hover:underline"
            >
              ← back to runs
            </Link>
            <h1 className="mt-1 text-xl font-semibold text-neutral-900">
              {account.name}
              <span className="ml-2 text-sm font-normal text-neutral-500">
                ({account.platform === 'TOKOPEDIA' ? 'Tokopedia' : 'Shopee'})
              </span>
            </h1>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
              <PassBadge pass={run.pass} />
              <StatusBadge status={run.status} />
              <span className="text-xs text-neutral-500">
                Trigger: {run.triggeredBy.toLowerCase()}
              </span>
            </div>
          </div>
          <div className="text-right text-xs text-neutral-600">
            <div>
              Started:{' '}
              <span className="font-mono">
                {formatTimestamp(run.startedAt)}
              </span>
            </div>
            <div>
              Completed:{' '}
              <span className="font-mono">
                {formatTimestamp(run.completedAt)}
              </span>
            </div>
            {run.modelUsed ? (
              <div>
                Model: <span className="font-mono">{run.modelUsed}</span>
              </div>
            ) : null}
          </div>
        </div>

        {run.errorMessage ? (
          <div className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
            <strong className="font-medium">Error:</strong> {run.errorMessage}
          </div>
        ) : null}

        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="Orders" value={run.orderCount} />
          <Stat label="New" value={run.newOrderCount} />
          <Stat label="Transitions" value={run.transitionCount} />
          <Stat
            label="Failed syncs"
            value={run.failedSyncs}
            tone={run.failedSyncs > 0 ? 'red' : 'neutral'}
          />
        </div>

        {failedLines.length > 0 ? (
          <div className="mt-4 flex items-center justify-between gap-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2">
            <div className="text-sm text-amber-900">
              <strong className="font-medium">
                {failedLines.length}
              </strong>{' '}
              line item{failedLines.length === 1 ? '' : 's'} are in{' '}
              <code className="rounded bg-amber-100 px-1 py-0.5 font-mono text-xs">
                SYNC_FAILED
              </code>
              . Retry triggers a new shipped-pass run for this account; the
              transition engine will re-attempt them.
            </div>
            <button
              type="button"
              onClick={onRetryFailed}
              disabled={retrying}
              className="inline-flex shrink-0 items-center justify-center rounded-md bg-amber-600 px-3 py-1.5 text-sm font-medium text-white shadow-sm transition hover:bg-amber-700 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {retrying ? 'Triggering…' : 'Retry via shipped scrape'}
            </button>
          </div>
        ) : null}
        {retryError ? (
          <div className="mt-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
            {retryError}
          </div>
        ) : null}
        {retryNotice ? (
          <div className="mt-2 rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-800">
            {retryNotice}
          </div>
        ) : null}
      </div>

      {/* Tabs */}
      <div className="rounded-lg border border-neutral-200 bg-white shadow-sm">
        <div className="flex items-center gap-1 border-b border-neutral-200 px-3 pt-2">
          <TabButton
            active={tab === 'orders'}
            onClick={() => setTab('orders')}
            label={`Orders (${orders.length})`}
          />
          <TabButton
            active={tab === 'raw'}
            onClick={() => setTab('raw')}
            label="Raw Data"
          />
        </div>

        {tab === 'orders' ? (
          <OrdersTab orders={orders} invenflowBaseUrl={invenflowBaseUrl} />
        ) : (
          <RawTab orders={orders} />
        )}
      </div>

      {/* Notes panel */}
      <div className="rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-800">
        Screenshots are stored in InvenFlow. Click an InvenFlow Product ID to
        view the card. Per-job logs are not persisted in v1.
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  tone = 'neutral',
}: {
  label: string;
  value: number;
  tone?: 'neutral' | 'red';
}) {
  const colour = tone === 'red' ? 'text-red-700' : 'text-neutral-900';
  return (
    <div className="rounded-md border border-neutral-200 bg-neutral-50 px-3 py-2">
      <div className="text-xs uppercase tracking-wide text-neutral-500">
        {label}
      </div>
      <div className={`mt-0.5 text-lg font-semibold ${colour}`}>{value}</div>
    </div>
  );
}

function TabButton({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-t-md px-3 py-2 text-sm font-medium transition ${
        active
          ? 'border-b-2 border-neutral-900 text-neutral-900'
          : 'text-neutral-600 hover:text-neutral-900'
      }`}
    >
      {label}
    </button>
  );
}

function OrdersTab({
  orders,
  invenflowBaseUrl,
}: {
  orders: OrderRow[];
  invenflowBaseUrl: string;
}) {
  if (orders.length === 0) {
    return (
      <div className="px-4 py-8 text-center text-sm text-neutral-600">
        No orders captured by this run.
      </div>
    );
  }
  return (
    <div className="divide-y divide-neutral-100">
      {orders.map((o) => (
        <div key={o.id} className="px-4 py-4">
          <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2 text-sm">
            <div>
              <span className="font-mono font-medium">{o.invoiceNumber}</span>
              {o.sellerName ? (
                <span className="ml-2 text-neutral-600">— {o.sellerName}</span>
              ) : null}
            </div>
            <div className="text-xs text-neutral-500">
              {formatTimestamp(o.orderDate)} · {formatRupiah(o.totalAmount)}
            </div>
          </div>
          <div className="overflow-x-auto rounded-md border border-neutral-200">
            <table className="min-w-full divide-y divide-neutral-200 text-xs">
              <thead className="bg-neutral-50 text-left text-[11px] uppercase tracking-wide text-neutral-500">
                <tr>
                  <th className="px-3 py-2">Product</th>
                  <th className="px-3 py-2">Qty</th>
                  <th className="px-3 py-2">Unit</th>
                  <th className="px-3 py-2">Subtotal</th>
                  <th className="px-3 py-2">State</th>
                  <th className="px-3 py-2">SKU</th>
                  <th className="px-3 py-2">InvenFlow</th>
                  <th className="px-3 py-2">Last sync error</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100">
                {o.lineItems.map((li) => (
                  <LineItemRow
                    key={li.id}
                    li={li}
                    invenflowBaseUrl={invenflowBaseUrl}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </div>
  );
}

function LineItemRow({
  li,
  invenflowBaseUrl,
}: {
  li: LineItem;
  invenflowBaseUrl: string;
}) {
  const [showFullError, setShowFullError] = useState(false);
  const error = li.lastSyncError ?? '';
  const truncated = error.length > 80 ? `${error.slice(0, 80)}…` : error;
  const productLink =
    li.invenflowProductId && invenflowBaseUrl
      ? `${invenflowBaseUrl.replace(/\/+$/, '')}/products/${li.invenflowProductId}`
      : null;

  return (
    <tr className="align-top">
      <td className="px-3 py-2">
        <div className="font-medium text-neutral-900">
          {li.marketplaceProductName}
        </div>
        {li.marketplaceProductUrl ? (
          <a
            className="text-[11px] text-blue-600 hover:underline"
            href={li.marketplaceProductUrl}
            target="_blank"
            rel="noreferrer"
          >
            marketplace link ↗
          </a>
        ) : null}
        <div className="mt-0.5 font-mono text-[11px] text-neutral-500">
          {li.lineItemId}
        </div>
      </td>
      <td className="px-3 py-2">{li.quantity}</td>
      <td className="px-3 py-2">{formatRupiah(li.unitPrice)}</td>
      <td className="px-3 py-2">{formatRupiah(li.subtotal)}</td>
      <td className="px-3 py-2">
        <LifecycleBadge state={li.lifecycleState} />
        {li.needsSkuMapping ? (
          <span className="ml-1 inline-flex rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-800">
            needs mapping
          </span>
        ) : null}
      </td>
      <td className="px-3 py-2 text-[11px] text-neutral-500">
        {/* SKU is not persisted on OrderLineItem locally — InvenFlow owns it. */}
        —
      </td>
      <td className="px-3 py-2 text-[11px]">
        {productLink ? (
          <a
            href={productLink}
            target="_blank"
            rel="noreferrer"
            className="font-mono text-blue-600 hover:underline"
          >
            {li.invenflowProductId?.slice(0, 8)}…
          </a>
        ) : li.invenflowProductId ? (
          <span className="font-mono text-neutral-700">
            {li.invenflowProductId.slice(0, 8)}…
          </span>
        ) : (
          <span className="text-neutral-400">—</span>
        )}
      </td>
      <td className="px-3 py-2 text-[11px]">
        {error ? (
          <button
            type="button"
            className="text-left text-red-700 hover:underline"
            onClick={() => setShowFullError((s) => !s)}
            title="Click to expand"
          >
            {showFullError ? error : truncated}
          </button>
        ) : (
          <span className="text-neutral-400">—</span>
        )}
        {li.syncRetryCount > 0 ? (
          <div className="text-[10px] text-neutral-500">
            retries: {li.syncRetryCount}
          </div>
        ) : null}
      </td>
    </tr>
  );
}

function RawTab({ orders }: { orders: OrderRow[] }) {
  if (orders.length === 0) {
    return (
      <div className="px-4 py-8 text-center text-sm text-neutral-600">
        No raw data — no orders were captured by this run.
      </div>
    );
  }
  return (
    <div className="divide-y divide-neutral-100">
      {orders.map((o) => (
        <RawCollapsible key={o.id} order={o} />
      ))}
    </div>
  );
}

function RawCollapsible({ order }: { order: OrderRow }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="px-4 py-3">
      <button
        type="button"
        onClick={() => setOpen((s) => !s)}
        className="flex items-center gap-2 text-left text-sm font-medium text-neutral-800 hover:underline"
      >
        <span className="text-neutral-500">{open ? '▼' : '▶'}</span>
        <span className="font-mono">{order.invoiceNumber}</span>
        <span className="text-xs text-neutral-500">
          ({order.lineItems.length} line item
          {order.lineItems.length === 1 ? '' : 's'})
        </span>
      </button>
      {open ? (
        <pre className="mt-2 max-h-96 overflow-auto rounded-md border border-neutral-200 bg-neutral-50 p-3 text-xs">
          {JSON.stringify(order.rawData, null, 2)}
        </pre>
      ) : null}
    </div>
  );
}

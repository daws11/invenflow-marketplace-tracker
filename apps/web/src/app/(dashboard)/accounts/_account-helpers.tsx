'use client';

// Small UI primitives shared between the account list page, the create form,
// and the edit form. Kept colocated under (dashboard)/accounts/ since they
// don't belong in the global Settings helper module — the visual treatment
// (status badges, platform pills) is account-specific.

import type { ReactNode } from 'react';

import type { AccountStatus, Platform } from '@prisma/client';

import { cronToHuman } from '@/lib/cron-format';

export function PlatformBadge({ platform }: { platform: Platform }) {
  // Tokopedia green, Shopee orange — matches the platforms' own brand
  // palettes well enough to be recognisable at a glance without becoming a
  // licensing concern (we're not using their logos).
  const palette =
    platform === 'TOKOPEDIA'
      ? 'bg-green-100 text-green-800'
      : 'bg-orange-100 text-orange-800';
  const label = platform === 'TOKOPEDIA' ? 'Tokopedia' : 'Shopee';
  return (
    <span
      className={`inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${palette}`}
    >
      {label}
    </span>
  );
}

export function StatusBadge({ status }: { status: AccountStatus }) {
  // Single source of truth for status colours so the list and detail views
  // never drift apart. `whitespace-nowrap` keeps "Not logged in" / "Session
  // expired" on one line; the leading dot gives a quick visual scan signal.
  const palette: Record<AccountStatus, string> = {
    NOT_LOGGED_IN: 'bg-neutral-100 text-neutral-700 ring-neutral-200',
    LOGGED_IN: 'bg-green-100 text-green-800 ring-green-200',
    SESSION_EXPIRED: 'bg-yellow-100 text-yellow-800 ring-yellow-200',
    ERROR: 'bg-red-100 text-red-800 ring-red-200',
  };
  const dot: Record<AccountStatus, string> = {
    NOT_LOGGED_IN: 'bg-neutral-400',
    LOGGED_IN: 'bg-green-500',
    SESSION_EXPIRED: 'bg-yellow-500',
    ERROR: 'bg-red-500',
  };
  const label: Record<AccountStatus, string> = {
    NOT_LOGGED_IN: 'Not logged in',
    LOGGED_IN: 'Logged in',
    SESSION_EXPIRED: 'Session expired',
    ERROR: 'Error',
  };
  return (
    <span
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${palette[status]}`}
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${dot[status]}`}
        aria-hidden="true"
      />
      {label[status]}
    </span>
  );
}

export function CronCellChip({ enabled }: { enabled: boolean }) {
  return (
    <span
      className={`inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${
        enabled
          ? 'bg-blue-50 text-blue-800 ring-blue-200'
          : 'bg-neutral-100 text-neutral-600 ring-neutral-200'
      }`}
    >
      {enabled ? 'Enabled' : 'Disabled'}
    </span>
  );
}

/**
 * Renders the schedule cell as: `[Enabled chip]` + two human-readable lines
 * for paid + shipped. Falls back to the raw cron expression when the
 * pattern isn't one of the recognised presets.
 */
export function CronCell({
  enabled,
  paid,
  shipped,
}: {
  enabled: boolean;
  paid: string;
  shipped: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      <CronCellChip enabled={enabled} />
      <div className={enabled ? 'text-xs text-neutral-700' : 'text-xs text-neutral-400'}>
        <div className="whitespace-nowrap">
          <span className="font-medium">Paid</span>
          <span className="mx-1 text-neutral-400">·</span>
          {cronToHuman(paid)}
        </div>
        <div className="whitespace-nowrap">
          <span className="font-medium">Shipped</span>
          <span className="mx-1 text-neutral-400">·</span>
          {cronToHuman(shipped)}
        </div>
      </div>
    </div>
  );
}

export function FieldGroup({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <div className="space-y-1">
      <span className="block text-sm font-medium text-neutral-700">{label}</span>
      {children}
      {hint ? <p className="text-xs text-neutral-500">{hint}</p> : null}
    </div>
  );
}

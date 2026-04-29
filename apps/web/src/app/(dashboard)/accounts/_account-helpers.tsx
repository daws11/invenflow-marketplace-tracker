'use client';

// Small UI primitives shared between the account list page, the create form,
// and the edit form. Kept colocated under (dashboard)/accounts/ since they
// don't belong in the global Settings helper module — the visual treatment
// (status badges, platform pills) is account-specific.

import type { ReactNode } from 'react';

import type { AccountStatus, Platform } from '@prisma/client';

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
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${palette}`}
    >
      {label}
    </span>
  );
}

export function StatusBadge({ status }: { status: AccountStatus }) {
  // Single source of truth for status colours so the list and detail views
  // never drift apart.
  const palette: Record<AccountStatus, string> = {
    NOT_LOGGED_IN: 'bg-neutral-200 text-neutral-700',
    LOGGED_IN: 'bg-green-100 text-green-800',
    SESSION_EXPIRED: 'bg-yellow-100 text-yellow-800',
    ERROR: 'bg-red-100 text-red-800',
  };
  const label: Record<AccountStatus, string> = {
    NOT_LOGGED_IN: 'Not logged in',
    LOGGED_IN: 'Logged in',
    SESSION_EXPIRED: 'Session expired',
    ERROR: 'Error',
  };
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${palette[status]}`}
    >
      {label[status]}
    </span>
  );
}

export function CronCellChip({ enabled }: { enabled: boolean }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
        enabled ? 'bg-blue-100 text-blue-800' : 'bg-neutral-200 text-neutral-700'
      }`}
    >
      {enabled ? 'Enabled' : 'Disabled'}
    </span>
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

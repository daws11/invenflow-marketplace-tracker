'use client';

// Tiny shared form primitives used by every settings tab. Kept inline in this
// folder rather than a global components dir because the dashboard skeleton
// is still being built — we'll promote them once a real design system lands.

import type { ReactNode } from 'react';

export function Field({
  id,
  label,
  hint,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1">
      <label
        htmlFor={id}
        className="block text-sm font-medium text-neutral-700"
      >
        {label}
      </label>
      {children}
      {hint ? <p className="text-xs text-neutral-500">{hint}</p> : null}
    </div>
  );
}

export const inputClass =
  'block w-full rounded-md border border-neutral-300 px-3 py-2 text-sm shadow-sm focus:border-neutral-500 focus:outline-none focus:ring-1 focus:ring-neutral-500';

export const buttonPrimaryClass =
  'inline-flex items-center justify-center rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-neutral-800 focus:outline-none focus:ring-2 focus:ring-neutral-500 focus:ring-offset-2 disabled:cursor-not-allowed disabled:bg-neutral-400';

export const buttonSecondaryClass =
  'inline-flex items-center justify-center rounded-md border border-neutral-300 bg-white px-4 py-2 text-sm font-medium text-neutral-700 shadow-sm transition hover:bg-neutral-50 focus:outline-none focus:ring-2 focus:ring-neutral-500 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60';

export function Banner({
  kind,
  children,
}: {
  kind: 'success' | 'error' | 'info';
  children: ReactNode;
}) {
  const palette =
    kind === 'success'
      ? 'border-green-200 bg-green-50 text-green-800'
      : kind === 'error'
        ? 'border-red-200 bg-red-50 text-red-800'
        : 'border-blue-200 bg-blue-50 text-blue-800';
  return (
    <div className={`rounded-md border px-3 py-2 text-sm ${palette}`}>
      {children}
    </div>
  );
}

export function Toggle({
  id,
  label,
  checked,
  onChange,
}: {
  id: string;
  label: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <label htmlFor={id} className="flex items-center gap-2 text-sm text-neutral-700">
      <input
        id={id}
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-4 w-4 rounded border-neutral-300 text-neutral-900 focus:ring-neutral-500"
      />
      <span>{label}</span>
    </label>
  );
}

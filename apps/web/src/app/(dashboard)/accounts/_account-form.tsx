'use client';

// Single account form used by both /accounts/new and /accounts/[id]/edit.
//
// PRD §7.2.2 calls this a wizard; we render it as a single page with a
// vertical flow because the dependencies between fields are simple and easy
// to communicate without a stepper. The cascading data fetches still apply:
//
//   1. Pick platform + name (no I/O).
//   2. Once mounted, GET /api/internal/invenflow/kanbans?type=order to fill
//      the kanban dropdown.
//   3. When a kanban is picked, GET .../kanbans/[id]/columns and use the
//      result to drive the two column dropdowns. Defaults: "purchased" /
//      "approved" if those are present (PRD-suggested, never enforced).
//   4. Cron schedules: text inputs prefilled from Settings defaults (loaded
//      via GET /api/settings) so the operator usually doesn't have to touch
//      them.
//   5. Optional fields collapsed behind a disclosure toggle.
//
// On edit we additionally lock the platform field — see disabled prop.

import { useRouter } from 'next/navigation';
import { type FormEvent, useEffect, useState } from 'react';

import {
  Banner,
  buttonPrimaryClass,
  buttonSecondaryClass,
  inputClass,
} from '../settings/_form-helpers';
import { FieldGroup } from './_account-helpers';

import type { Platform } from '@prisma/client';

import {
  buildCron,
  cronToHuman,
  formatTime,
  parseCron,
  type SchedulePreset,
} from '@/lib/cron-format';

const PLATFORMS: { value: Platform; label: string }[] = [
  { value: 'TOKOPEDIA', label: 'Tokopedia' },
  { value: 'SHOPEE', label: 'Shopee' },
];

const PREFERRED_PAID_COLUMN = 'purchased';
const PREFERRED_SHIPPED_COLUMN = 'approved';
const FALLBACK_CRON_DIBAYAR = '0 10 * * 1-5';
const FALLBACK_CRON_DIKIRIM = '0 14 * * 1-5';

interface KanbanItem {
  id: string;
  name: string;
}

interface KanbanListBody {
  kanbans: KanbanItem[];
}

interface KanbanColumnsBody {
  kanbanId: string;
  columns: string[];
}

export interface AccountFormValues {
  name: string;
  platform: Platform;
  invenflowKanbanId: string;
  invenflowKanbanName: string;
  columnOnPaid: string;
  columnOnShipped: string;
  cronEnabled: boolean;
  cronScheduleDibayar: string;
  cronScheduleDikirim: string;
  paidUrlOverride: string;
  shippedUrlOverride: string;
  notes: string;
}

export interface AccountFormProps {
  /** Pre-filled values; in `create` mode pass an empty defaults object. */
  initialValues?: Partial<AccountFormValues>;
  /** "create" or "edit". On edit, platform is locked. */
  mode: 'create' | 'edit';
  /**
   * Called when the form is submitted with the validated payload. Should
   * perform the network request and throw on failure (with a user-readable
   * message); the form handles the banner / disabled state.
   */
  onSubmit: (values: AccountFormValues) => Promise<void>;
}

const EMPTY: AccountFormValues = {
  name: '',
  platform: 'TOKOPEDIA',
  invenflowKanbanId: '',
  invenflowKanbanName: '',
  columnOnPaid: '',
  columnOnShipped: '',
  cronEnabled: true,
  cronScheduleDibayar: FALLBACK_CRON_DIBAYAR,
  cronScheduleDikirim: FALLBACK_CRON_DIKIRIM,
  paidUrlOverride: '',
  shippedUrlOverride: '',
  notes: '',
};

export function AccountForm({
  mode,
  initialValues,
  onSubmit,
}: AccountFormProps) {
  const router = useRouter();
  const [values, setValues] = useState<AccountFormValues>({
    ...EMPTY,
    ...initialValues,
  });

  const [kanbans, setKanbans] = useState<KanbanItem[]>([]);
  const [kanbansState, setKanbansState] = useState<
    'idle' | 'loading' | 'ok' | 'error'
  >('idle');
  const [kanbansError, setKanbansError] = useState<string | null>(null);

  const [columns, setColumns] = useState<string[]>([]);
  const [columnsState, setColumnsState] = useState<
    'idle' | 'loading' | 'ok' | 'error'
  >('idle');
  const [columnsError, setColumnsError] = useState<string | null>(null);

  const [showAdvanced, setShowAdvanced] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [banner, setBanner] = useState<
    { kind: 'success' | 'error'; msg: string } | null
  >(null);

  // ---------------------------------------------------------------------------
  // Schedule UI state.
  //
  // The two cron strings are still the source of truth in the form payload
  // (and in the DB), but the operator interacts with a friendlier UI: pick a
  // frequency preset + two times. Whenever those change we rebuild the cron
  // expressions and write them back into `values`. "Custom" exposes raw cron
  // inputs as a fallback for power-users who need a pattern outside the
  // recognised presets.
  // ---------------------------------------------------------------------------

  const [preset, setPreset] = useState<SchedulePreset>(() => {
    const a = parseCron(initialValues?.cronScheduleDibayar ?? FALLBACK_CRON_DIBAYAR);
    const b = parseCron(initialValues?.cronScheduleDikirim ?? FALLBACK_CRON_DIKIRIM);
    if (a && b && a.preset === b.preset && a.preset !== 'custom') {
      return a.preset;
    }
    return 'custom';
  });
  const [paidTime, setPaidTime] = useState<{ hour: number; minute: number }>(
    () => {
      const a = parseCron(initialValues?.cronScheduleDibayar ?? FALLBACK_CRON_DIBAYAR);
      return a ? { hour: a.hour, minute: a.minute } : { hour: 10, minute: 0 };
    },
  );
  const [shippedTime, setShippedTime] = useState<{
    hour: number;
    minute: number;
  }>(() => {
    const b = parseCron(initialValues?.cronScheduleDikirim ?? FALLBACK_CRON_DIKIRIM);
    return b ? { hour: b.hour, minute: b.minute } : { hour: 14, minute: 0 };
  });

  // When the operator picks a preset (other than custom) or changes a time,
  // rebuild the cron expressions in form state. We don't run this for the
  // "custom" preset — there the text inputs write directly to `values`.
  useEffect(() => {
    if (preset === 'custom') return;
    setValues((v) => ({
      ...v,
      cronScheduleDibayar: buildCron({ preset, ...paidTime }),
      cronScheduleDikirim: buildCron({ preset, ...shippedTime }),
    }));
  }, [preset, paidTime, shippedTime]);

  // If /api/settings (create-mode) overwrites the cron strings AFTER mount,
  // refresh the preset/time state to match. Triggers on string changes only.
  // Guarded against ping-pong with the build-cron effect above: we only
  // call set* when the parsed value actually differs from current state,
  // so React's structural equality check on primitive deps stops the loop.
  useEffect(() => {
    const a = parseCron(values.cronScheduleDibayar);
    const b = parseCron(values.cronScheduleDikirim);
    if (!(a && b && a.preset === b.preset && a.preset !== 'custom')) return;
    if (preset !== a.preset) setPreset(a.preset);
    if (paidTime.hour !== a.hour || paidTime.minute !== a.minute) {
      setPaidTime({ hour: a.hour, minute: a.minute });
    }
    if (shippedTime.hour !== b.hour || shippedTime.minute !== b.minute) {
      setShippedTime({ hour: b.hour, minute: b.minute });
    }
    // Reading preset/paidTime/shippedTime here is a guard, not a dependency —
    // we only want to react to STRING changes. eslint disabled accordingly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [values.cronScheduleDibayar, values.cronScheduleDikirim]);

  // ---------------------------------------------------------------------------
  // Initial loads: kanbans + (in create mode) the cron defaults from Settings.
  // We refetch kanbans whenever the operator clicks the "Retry" button by
  // bumping `kanbansAttempt`.
  // ---------------------------------------------------------------------------

  const [kanbansAttempt, setKanbansAttempt] = useState(0);

  useEffect(() => {
    setKanbansState('loading');
    setKanbansError(null);
    void (async () => {
      try {
        const res = await fetch(
          '/api/internal/invenflow/kanbans?type=order',
        );
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(
            typeof data?.error === 'string'
              ? data.error
              : `Failed to load kanbans (${res.status})`,
          );
        }
        const list = Array.isArray((data as KanbanListBody).kanbans)
          ? (data as KanbanListBody).kanbans
          : [];
        setKanbans(list);
        setKanbansState('ok');
      } catch (err) {
        setKanbansError((err as Error).message);
        setKanbansState('error');
      }
    })();
  }, [kanbansAttempt]);

  // Cron defaults: only relevant on create. On edit we trust whatever the
  // account already has stored.
  useEffect(() => {
    if (mode !== 'create') return;
    void (async () => {
      try {
        const res = await fetch('/api/settings');
        if (!res.ok) return;
        const data = (await res.json()) as {
          defaultCronDibayar?: string | null;
          defaultCronDikirim?: string | null;
        };
        setValues((v) => ({
          ...v,
          cronScheduleDibayar:
            data.defaultCronDibayar ?? v.cronScheduleDibayar,
          cronScheduleDikirim:
            data.defaultCronDikirim ?? v.cronScheduleDikirim,
        }));
      } catch {
        // non-fatal — fall back to the defaults already in state
      }
    })();
  }, [mode]);

  // Whenever the kanban id changes (either because the operator picked a
  // new one or because a pre-fill arrived), fetch the column list.
  useEffect(() => {
    const id = values.invenflowKanbanId;
    if (!id) {
      setColumns([]);
      setColumnsState('idle');
      setColumnsError(null);
      return;
    }
    setColumnsState('loading');
    setColumnsError(null);
    void (async () => {
      try {
        const res = await fetch(
          `/api/internal/invenflow/kanbans/${encodeURIComponent(id)}/columns`,
        );
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(
            typeof data?.error === 'string'
              ? data.error
              : `Failed to load columns (${res.status})`,
          );
        }
        const list = Array.isArray((data as KanbanColumnsBody).columns)
          ? (data as KanbanColumnsBody).columns
          : [];
        setColumns(list);
        setColumnsState('ok');

        // Apply suggested defaults (PRD §7.2.2 step 4) — but only if the
        // current values are empty and the suggested column actually exists
        // in the freshly-loaded list. On edit this leaves the existing
        // selections untouched.
        setValues((v) => ({
          ...v,
          columnOnPaid:
            v.columnOnPaid === '' && list.includes(PREFERRED_PAID_COLUMN)
              ? PREFERRED_PAID_COLUMN
              : v.columnOnPaid,
          columnOnShipped:
            v.columnOnShipped === '' &&
            list.includes(PREFERRED_SHIPPED_COLUMN)
              ? PREFERRED_SHIPPED_COLUMN
              : v.columnOnShipped,
        }));
      } catch (err) {
        setColumnsError((err as Error).message);
        setColumnsState('error');
      }
    })();
  }, [values.invenflowKanbanId]);

  // ---------------------------------------------------------------------------
  // Submit
  // ---------------------------------------------------------------------------

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBanner(null);

    if (!values.name.trim()) {
      setBanner({ kind: 'error', msg: 'Name is required.' });
      return;
    }
    if (!values.invenflowKanbanId) {
      setBanner({ kind: 'error', msg: 'Pick a kanban.' });
      return;
    }
    if (!values.columnOnPaid || !values.columnOnShipped) {
      setBanner({ kind: 'error', msg: 'Pick both columns.' });
      return;
    }

    setSubmitting(true);
    try {
      await onSubmit(values);
    } catch (err) {
      setBanner({ kind: 'error', msg: (err as Error).message });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <section className="space-y-4 rounded-lg border border-neutral-200 bg-white p-6 shadow-sm">
        <h2 className="text-base font-semibold text-neutral-900">
          1. Basics
        </h2>
        <FieldGroup label="Account name" hint="Operator-facing label, e.g. 'Toko Bro Olive' or 'Shopee Main'.">
          <input
            type="text"
            required
            value={values.name}
            onChange={(e) =>
              setValues((v) => ({ ...v, name: e.target.value }))
            }
            className={inputClass}
          />
        </FieldGroup>

        <FieldGroup label="Platform">
          <div className="flex gap-2">
            {PLATFORMS.map((p) => {
              const active = values.platform === p.value;
              const disabled = mode === 'edit';
              return (
                <button
                  key={p.value}
                  type="button"
                  disabled={disabled}
                  onClick={() =>
                    setValues((v) => ({ ...v, platform: p.value }))
                  }
                  className={`flex-1 rounded-md border px-4 py-2 text-sm font-medium transition ${
                    active
                      ? 'border-neutral-900 bg-neutral-900 text-white'
                      : 'border-neutral-300 bg-white text-neutral-700 hover:bg-neutral-50'
                  } ${disabled ? 'cursor-not-allowed opacity-60' : ''}`}
                  aria-pressed={active}
                >
                  {p.label}
                </button>
              );
            })}
          </div>
          {mode === 'edit' ? (
            <p className="text-xs text-neutral-500">
              Platform is fixed once the account exists — create a new account
              to track a different marketplace login.
            </p>
          ) : null}
        </FieldGroup>
      </section>

      <section className="space-y-4 rounded-lg border border-neutral-200 bg-white p-6 shadow-sm">
        <h2 className="text-base font-semibold text-neutral-900">
          2. InvenFlow target
        </h2>

        <FieldGroup
          label="Kanban"
          hint="Pulled from the InvenFlow instance configured in Settings."
        >
          {kanbansState === 'loading' ? (
            <div className="h-9 animate-pulse rounded-md bg-neutral-100" />
          ) : kanbansState === 'error' ? (
            <div className="space-y-2">
              <Banner kind="error">
                Couldn&rsquo;t load kanbans
                {kanbansError ? `: ${kanbansError}` : '.'}
              </Banner>
              <button
                type="button"
                onClick={() => setKanbansAttempt((n) => n + 1)}
                className={buttonSecondaryClass}
              >
                Retry
              </button>
            </div>
          ) : (
            <select
              required
              value={values.invenflowKanbanId}
              onChange={(e) => {
                const id = e.target.value;
                const found = kanbans.find((k) => k.id === id);
                setValues((v) => ({
                  ...v,
                  invenflowKanbanId: id,
                  invenflowKanbanName: found?.name ?? '',
                  // Clear columns so suggested defaults can re-apply against
                  // the new kanban's column list.
                  columnOnPaid: '',
                  columnOnShipped: '',
                }));
              }}
              className={inputClass}
            >
              <option value="">— select a kanban —</option>
              {kanbans.map((k) => (
                <option key={k.id} value={k.id}>
                  {k.name}
                </option>
              ))}
            </select>
          )}
        </FieldGroup>

        <div className="grid gap-4 md:grid-cols-2">
          <FieldGroup
            label="Column on paid"
            hint="Sidecar drops new orders into this column."
          >
            {columnsState === 'loading' ? (
              <div className="h-9 animate-pulse rounded-md bg-neutral-100" />
            ) : columnsState === 'error' ? (
              <Banner kind="error">
                Couldn&rsquo;t load columns
                {columnsError ? `: ${columnsError}` : '.'}
              </Banner>
            ) : (
              <select
                required
                disabled={columnsState !== 'ok'}
                value={values.columnOnPaid}
                onChange={(e) =>
                  setValues((v) => ({ ...v, columnOnPaid: e.target.value }))
                }
                className={inputClass}
              >
                <option value="">— select a column —</option>
                {columns.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            )}
          </FieldGroup>

          <FieldGroup
            label="Column on shipped"
            hint="Sidecar transitions cards here when the marketplace marks them shipped."
          >
            {columnsState === 'loading' ? (
              <div className="h-9 animate-pulse rounded-md bg-neutral-100" />
            ) : columnsState === 'error' ? (
              <Banner kind="error">
                Couldn&rsquo;t load columns
                {columnsError ? `: ${columnsError}` : '.'}
              </Banner>
            ) : (
              <select
                required
                disabled={columnsState !== 'ok'}
                value={values.columnOnShipped}
                onChange={(e) =>
                  setValues((v) => ({
                    ...v,
                    columnOnShipped: e.target.value,
                  }))
                }
                className={inputClass}
              >
                <option value="">— select a column —</option>
                {columns.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            )}
          </FieldGroup>
        </div>
      </section>

      <section className="space-y-4 rounded-lg border border-neutral-200 bg-white p-6 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-base font-semibold text-neutral-900">
            3. Schedule
          </h2>
          <label className="flex items-center gap-2 text-sm text-neutral-700">
            <input
              type="checkbox"
              checked={values.cronEnabled}
              onChange={(e) =>
                setValues((v) => ({ ...v, cronEnabled: e.target.checked }))
              }
              className="h-4 w-4 rounded border-neutral-300 text-neutral-900 focus:ring-neutral-500"
            />
            Run on a schedule
          </label>
        </div>

        {!values.cronEnabled ? (
          <p className="rounded-md border border-dashed border-neutral-300 bg-neutral-50 px-3 py-2 text-sm text-neutral-600">
            Scheduled scrapes are paused for this account. You can still ingest
            orders manually via Open Browser or the Run buttons on the dashboard.
          </p>
        ) : (
          <>
            <FieldGroup
              label="Frequency"
              hint="Choose when scrapes should run. Times are in Asia/Jakarta."
            >
              <select
                value={preset}
                onChange={(e) =>
                  setPreset(e.target.value as SchedulePreset)
                }
                className={inputClass}
              >
                <option value="weekdays">Weekdays (Mon–Fri)</option>
                <option value="daily">Every day</option>
                <option value="weekends">Weekends (Sat–Sun)</option>
                <option value="custom">Custom (advanced)</option>
              </select>
            </FieldGroup>

            {preset === 'custom' ? (
              <div className="grid gap-4 md:grid-cols-2">
                <FieldGroup
                  label="Paid (dibayar) cron"
                  hint="5-field cron, e.g. 0 10 * * 1-5 (10:00 Mon–Fri)."
                >
                  <input
                    type="text"
                    value={values.cronScheduleDibayar}
                    onChange={(e) =>
                      setValues((v) => ({
                        ...v,
                        cronScheduleDibayar: e.target.value,
                      }))
                    }
                    className={`${inputClass} font-mono`}
                  />
                </FieldGroup>
                <FieldGroup
                  label="Shipped (dikirim) cron"
                  hint="5-field cron, e.g. 0 14 * * 1-5 (14:00 Mon–Fri)."
                >
                  <input
                    type="text"
                    value={values.cronScheduleDikirim}
                    onChange={(e) =>
                      setValues((v) => ({
                        ...v,
                        cronScheduleDikirim: e.target.value,
                      }))
                    }
                    className={`${inputClass} font-mono`}
                  />
                </FieldGroup>
              </div>
            ) : (
              <div className="grid gap-4 md:grid-cols-2">
                <FieldGroup
                  label="Paid scrape time"
                  hint="When to ingest newly-paid orders (status=Dibayar)."
                >
                  <input
                    type="time"
                    value={formatTime(paidTime.hour, paidTime.minute)}
                    onChange={(e) => {
                      const [h, m] = e.target.value.split(':').map(Number);
                      if (Number.isFinite(h) && Number.isFinite(m)) {
                        setPaidTime({ hour: h, minute: m });
                      }
                    }}
                    className={inputClass}
                  />
                </FieldGroup>
                <FieldGroup
                  label="Shipped scrape time"
                  hint="When to mark cards as shipped (status=Dikirim)."
                >
                  <input
                    type="time"
                    value={formatTime(shippedTime.hour, shippedTime.minute)}
                    onChange={(e) => {
                      const [h, m] = e.target.value.split(':').map(Number);
                      if (Number.isFinite(h) && Number.isFinite(m)) {
                        setShippedTime({ hour: h, minute: m });
                      }
                    }}
                    className={inputClass}
                  />
                </FieldGroup>
              </div>
            )}

            <div className="rounded-md bg-neutral-50 px-3 py-2 text-xs text-neutral-700">
              <p>
                <span className="font-medium">Paid:</span>{' '}
                {cronToHuman(values.cronScheduleDibayar)}
              </p>
              <p>
                <span className="font-medium">Shipped:</span>{' '}
                {cronToHuman(values.cronScheduleDikirim)}
              </p>
              <p className="mt-1 text-[11px] text-neutral-500">
                Asia/Jakarta · cron:{' '}
                <span className="font-mono">
                  {values.cronScheduleDibayar}
                </span>{' '}
                /{' '}
                <span className="font-mono">
                  {values.cronScheduleDikirim}
                </span>
              </p>
            </div>
          </>
        )}
      </section>

      <section className="rounded-lg border border-neutral-200 bg-white p-6 shadow-sm">
        <button
          type="button"
          onClick={() => setShowAdvanced((s) => !s)}
          className="text-sm font-medium text-neutral-700 hover:text-neutral-900"
          aria-expanded={showAdvanced}
        >
          {showAdvanced ? '− Hide advanced' : '+ Advanced (URL overrides, notes)'}
        </button>

        {showAdvanced ? (
          <div className="mt-4 space-y-4">
            <FieldGroup
              label="Paid-pass URL override"
              hint="Optional. Use only if you need to scrape a different filter URL than the platform default."
            >
              <input
                type="url"
                value={values.paidUrlOverride}
                onChange={(e) =>
                  setValues((v) => ({
                    ...v,
                    paidUrlOverride: e.target.value,
                  }))
                }
                className={inputClass}
                placeholder="https://…"
              />
            </FieldGroup>

            <FieldGroup label="Shipped-pass URL override" hint="Optional.">
              <input
                type="url"
                value={values.shippedUrlOverride}
                onChange={(e) =>
                  setValues((v) => ({
                    ...v,
                    shippedUrlOverride: e.target.value,
                  }))
                }
                className={inputClass}
                placeholder="https://…"
              />
            </FieldGroup>

            <FieldGroup label="Notes" hint="Operator-only — never sent to InvenFlow.">
              <textarea
                value={values.notes}
                onChange={(e) =>
                  setValues((v) => ({ ...v, notes: e.target.value }))
                }
                rows={3}
                className={inputClass}
              />
            </FieldGroup>
          </div>
        ) : null}
      </section>

      {banner ? <Banner kind={banner.kind}>{banner.msg}</Banner> : null}

      <div className="flex flex-wrap gap-3">
        <button
          type="submit"
          disabled={submitting}
          className={buttonPrimaryClass}
        >
          {submitting
            ? 'Saving…'
            : mode === 'create'
              ? 'Create account'
              : 'Save changes'}
        </button>
        <button
          type="button"
          onClick={() => router.push('/accounts')}
          className={buttonSecondaryClass}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

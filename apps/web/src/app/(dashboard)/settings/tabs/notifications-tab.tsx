'use client';

// Notifications (Fonnte) tab — token, WA target, per-event toggles, "Send
// Test" button (PRD §11.4 + §7.7 trigger list).

import { type FormEvent, useEffect, useState } from 'react';

import {
  Banner,
  Field,
  Toggle,
  buttonPrimaryClass,
  buttonSecondaryClass,
  inputClass,
} from '../_form-helpers';

interface Values {
  fonnteToken: string;
  fonnteTarget: string;
  notifyOnRunStart: boolean;
  notifyOnRunSuccess: boolean;
  notifyOnRunFail: boolean;
  notifyOnLoginRequired: boolean;
  notifyOnSessionExpired: boolean;
}

interface TestResult {
  ok: boolean;
  error?: string;
}

const INITIAL: Values = {
  fonnteToken: '',
  fonnteTarget: '',
  notifyOnRunStart: false,
  notifyOnRunSuccess: true,
  notifyOnRunFail: true,
  notifyOnLoginRequired: true,
  notifyOnSessionExpired: true,
};

export function NotificationsTab() {
  const [values, setValues] = useState<Values>(INITIAL);
  const [tokenTouched, setTokenTouched] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [testing, setTesting] = useState(false);
  const [banner, setBanner] = useState<
    { kind: 'success' | 'error'; msg: string } | null
  >(null);
  const [testResult, setTestResult] = useState<TestResult | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch('/api/settings');
        if (!res.ok) throw new Error('Failed to load settings');
        const data = await res.json();
        setValues({
          fonnteToken: data.fonnteTokenSet ? '***' : '',
          fonnteTarget: data.fonnteTarget ?? '',
          notifyOnRunStart: !!data.notifyOnRunStart,
          notifyOnRunSuccess: !!data.notifyOnRunSuccess,
          notifyOnRunFail: !!data.notifyOnRunFail,
          notifyOnLoginRequired: !!data.notifyOnLoginRequired,
          notifyOnSessionExpired: !!data.notifyOnSessionExpired,
        });
      } catch (err) {
        setBanner({ kind: 'error', msg: (err as Error).message });
      } finally {
        setLoaded(true);
      }
    })();
  }, []);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSubmitting(true);
    setBanner(null);
    try {
      const payload: Record<string, unknown> = {
        fonnteTarget: values.fonnteTarget,
        notifyOnRunStart: values.notifyOnRunStart,
        notifyOnRunSuccess: values.notifyOnRunSuccess,
        notifyOnRunFail: values.notifyOnRunFail,
        notifyOnLoginRequired: values.notifyOnLoginRequired,
        notifyOnSessionExpired: values.notifyOnSessionExpired,
      };
      if (
        tokenTouched &&
        values.fonnteToken &&
        values.fonnteToken !== '***'
      ) {
        payload.fonnteToken = values.fonnteToken;
      }
      const res = await fetch('/api/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? 'Failed to save');
      }
      setBanner({ kind: 'success', msg: 'Saved.' });
      setTokenTouched(false);
      setValues((v) => ({ ...v, fonnteToken: '***' }));
    } catch (err) {
      setBanner({ kind: 'error', msg: (err as Error).message });
    } finally {
      setSubmitting(false);
    }
  }

  async function onTest() {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch('/api/settings/notifications/test', {
        method: 'POST',
      });
      const data = (await res.json()) as TestResult;
      setTestResult(data);
    } catch (err) {
      setTestResult({ ok: false, error: (err as Error).message });
    } finally {
      setTesting(false);
    }
  }

  if (!loaded) return <p className="text-sm text-neutral-500">Loading…</p>;

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <Field
        id="fonnteToken"
        label="Fonnte API token"
        hint="From https://md.fonnte.com. Leave as *** to keep the existing token."
      >
        <input
          id="fonnteToken"
          type="password"
          autoComplete="off"
          value={values.fonnteToken}
          onFocus={() => {
            if (values.fonnteToken === '***') {
              setValues((v) => ({ ...v, fonnteToken: '' }));
            }
          }}
          onChange={(e) => {
            setTokenTouched(true);
            setValues((v) => ({ ...v, fonnteToken: e.target.value }));
          }}
          className={inputClass}
        />
      </Field>

      <Field
        id="fonnteTarget"
        label="WhatsApp number"
        hint="Default delivery target, e.g. 628xxxxxxxxxx"
      >
        <input
          id="fonnteTarget"
          type="text"
          value={values.fonnteTarget}
          onChange={(e) =>
            setValues((v) => ({ ...v, fonnteTarget: e.target.value }))
          }
          className={inputClass}
        />
      </Field>

      <fieldset className="space-y-2 rounded-md border border-neutral-200 p-3">
        <legend className="px-1 text-sm font-medium text-neutral-700">
          Notify on
        </legend>
        <Toggle
          id="notifyOnRunStart"
          label="Run start"
          checked={values.notifyOnRunStart}
          onChange={(b) => setValues((v) => ({ ...v, notifyOnRunStart: b }))}
        />
        <Toggle
          id="notifyOnRunSuccess"
          label="Run success"
          checked={values.notifyOnRunSuccess}
          onChange={(b) => setValues((v) => ({ ...v, notifyOnRunSuccess: b }))}
        />
        <Toggle
          id="notifyOnRunFail"
          label="Run failure"
          checked={values.notifyOnRunFail}
          onChange={(b) => setValues((v) => ({ ...v, notifyOnRunFail: b }))}
        />
        <Toggle
          id="notifyOnLoginRequired"
          label="Login required (browser session opened)"
          checked={values.notifyOnLoginRequired}
          onChange={(b) =>
            setValues((v) => ({ ...v, notifyOnLoginRequired: b }))
          }
        />
        <Toggle
          id="notifyOnSessionExpired"
          label="Session expired"
          checked={values.notifyOnSessionExpired}
          onChange={(b) =>
            setValues((v) => ({ ...v, notifyOnSessionExpired: b }))
          }
        />
      </fieldset>

      {banner ? <Banner kind={banner.kind}>{banner.msg}</Banner> : null}

      {testResult ? (
        <Banner kind={testResult.ok ? 'success' : 'error'}>
          {testResult.ok ? (
            <strong>Test message sent.</strong>
          ) : (
            <>
              <strong>Failed</strong>
              {testResult.error ? `: ${testResult.error}` : ''}
            </>
          )}
        </Banner>
      ) : null}

      <div className="flex flex-wrap gap-3">
        <button
          type="submit"
          disabled={submitting}
          className={buttonPrimaryClass}
        >
          {submitting ? 'Saving…' : 'Save'}
        </button>
        <button
          type="button"
          onClick={onTest}
          disabled={testing}
          className={buttonSecondaryClass}
        >
          {testing ? 'Sending…' : 'Send Test'}
        </button>
      </div>
    </form>
  );
}

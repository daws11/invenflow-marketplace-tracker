'use client';

// InvenFlow Connection tab — base URL + default service token + test button
// (PRD §11.3). The token field shows '***' when one is already saved; the
// user must type a new value to overwrite it.

import { type FormEvent, useEffect, useState } from 'react';

import {
  Banner,
  Field,
  buttonPrimaryClass,
  buttonSecondaryClass,
  inputClass,
} from '../_form-helpers';

interface Values {
  invenflowBaseUrl: string;
  invenflowServiceToken: string; // '***' when one is set on the server
}

interface TestResult {
  ok: boolean;
  response?: unknown;
  error?: string;
}

export function InvenflowTab() {
  const [values, setValues] = useState<Values>({
    invenflowBaseUrl: '',
    invenflowServiceToken: '',
  });
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
          invenflowBaseUrl: data.invenflowBaseUrl ?? '',
          invenflowServiceToken: data.invenflowServiceTokenSet ? '***' : '',
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
        invenflowBaseUrl: values.invenflowBaseUrl,
      };
      if (
        tokenTouched &&
        values.invenflowServiceToken &&
        values.invenflowServiceToken !== '***'
      ) {
        payload.invenflowServiceToken = values.invenflowServiceToken;
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
      setValues((v) => ({ ...v, invenflowServiceToken: '***' }));
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
      const res = await fetch('/api/settings/invenflow/test', {
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
        id="invenflowBaseUrl"
        label="InvenFlow base URL"
        hint="Public URL of your InvenFlow instance, e.g. https://inv.example.com"
      >
        <input
          id="invenflowBaseUrl"
          type="url"
          required
          value={values.invenflowBaseUrl}
          onChange={(e) =>
            setValues((v) => ({ ...v, invenflowBaseUrl: e.target.value }))
          }
          className={inputClass}
        />
      </Field>

      <Field
        id="invenflowServiceToken"
        label="Default service token"
        hint="Created at /settings/service-tokens in InvenFlow. Leave as *** to keep the existing token."
      >
        <input
          id="invenflowServiceToken"
          type="password"
          autoComplete="off"
          value={values.invenflowServiceToken}
          onFocus={() => {
            if (values.invenflowServiceToken === '***') {
              setValues((v) => ({ ...v, invenflowServiceToken: '' }));
            }
          }}
          onChange={(e) => {
            setTokenTouched(true);
            setValues((v) => ({ ...v, invenflowServiceToken: e.target.value }));
          }}
          className={inputClass}
        />
      </Field>

      {banner ? <Banner kind={banner.kind}>{banner.msg}</Banner> : null}

      {testResult ? (
        <Banner kind={testResult.ok ? 'success' : 'error'}>
          {testResult.ok ? (
            <>
              <strong>OK</strong> — InvenFlow responded.
              {testResult.response ? (
                <pre className="mt-1 overflow-x-auto rounded bg-white p-2 text-xs text-neutral-700">
                  {JSON.stringify(testResult.response, null, 2)}
                </pre>
              ) : null}
            </>
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
          {testing ? 'Testing…' : 'Test Connection'}
        </button>
      </div>
    </form>
  );
}

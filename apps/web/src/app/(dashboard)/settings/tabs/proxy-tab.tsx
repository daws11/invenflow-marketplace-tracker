'use client';

// Proxy tab — outbound proxy used by the worker's Chromium launches when
// the operator wants browser sessions to exit through an Indonesian
// residential / mobile proxy (PRD §13). Without this Tokopedia / Shopee
// hard-block the EU datacenter IP and the login pages return 403 / "Maaf
// permintaan Anda tidak dapat diproses".

import { type FormEvent, useEffect, useState } from 'react';

import {
  Banner,
  Field,
  buttonPrimaryClass,
  buttonSecondaryClass,
  inputClass,
} from '../_form-helpers';

interface ProxyValues {
  enabled: boolean;
  server: string;
  username: string;
  password: string; // '***' when fetched from server and a password is set
}

const INITIAL: ProxyValues = {
  enabled: false,
  server: '',
  username: '',
  password: '',
};

interface TestResult {
  ok: boolean;
  ip?: string | null;
  city?: string | null;
  region?: string | null;
  country?: string | null;
  org?: string | null;
  timezone?: string | null;
  error?: string;
}

export function ProxyTab() {
  const [values, setValues] = useState<ProxyValues>(INITIAL);
  const [loaded, setLoaded] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [testing, setTesting] = useState(false);
  const [banner, setBanner] = useState<
    { kind: 'success' | 'error'; msg: string } | null
  >(null);
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [pwdTouched, setPwdTouched] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch('/api/settings/proxy');
        if (!res.ok) throw new Error('Failed to load proxy settings');
        const data = await res.json();
        setValues({
          enabled: Boolean(data.enabled),
          server: typeof data.server === 'string' ? data.server : '',
          username: typeof data.username === 'string' ? data.username : '',
          password: data.passwordSet ? '***' : '',
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
        enabled: values.enabled,
        server: values.server,
        username: values.username,
      };
      if (pwdTouched && values.password && values.password !== '***') {
        payload.password = values.password;
      }
      const res = await fetch('/api/settings/proxy', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? 'Failed to save');
      }
      setBanner({ kind: 'success', msg: 'Saved.' });
      setPwdTouched(false);
      setValues((v) => ({ ...v, password: v.password ? '***' : '' }));
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
      const body: Record<string, unknown> = {};
      // Send overrides only when the operator typed a fresh password
      // since loading. Otherwise the server falls back to saved values
      // and we test what's actually persisted.
      if (pwdTouched && values.password && values.password !== '***') {
        body.server = values.server;
        body.username = values.username;
        body.password = values.password;
      } else if (values.server) {
        body.server = values.server;
        body.username = values.username;
      }
      const res = await fetch('/api/settings/proxy/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
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
      <div className="rounded-md bg-blue-50 px-3 py-2 text-xs text-blue-900">
        Marketplace pages (Tokopedia, Shopee) block traffic from non-Indonesian
        datacenter IPs. If your VPS is outside Indonesia, route browser
        sessions through an Indonesian residential or mobile proxy here. The
        worker passes <code className="font-mono">--proxy-server</code> to
        Chromium for every session — no other traffic is affected.
      </div>

      <label className="flex items-center gap-2 text-sm text-neutral-700">
        <input
          type="checkbox"
          checked={values.enabled}
          onChange={(e) =>
            setValues((v) => ({ ...v, enabled: e.target.checked }))
          }
          className="h-4 w-4 rounded border-neutral-300 text-neutral-900 focus:ring-neutral-500"
        />
        Route browser sessions through this proxy
      </label>

      <Field
        id="proxy-server"
        label="Proxy URL"
        hint="e.g. http://gate.smartproxy.com:7000 or socks5://us-residential.example:1080. Include the scheme."
      >
        <input
          id="proxy-server"
          type="url"
          value={values.server}
          onChange={(e) => setValues((v) => ({ ...v, server: e.target.value }))}
          placeholder="http://host:port"
          className={inputClass}
        />
      </Field>

      <div className="grid gap-4 md:grid-cols-2">
        <Field id="proxy-username" label="Username (optional)">
          <input
            id="proxy-username"
            type="text"
            autoComplete="off"
            value={values.username}
            onChange={(e) =>
              setValues((v) => ({ ...v, username: e.target.value }))
            }
            className={inputClass}
          />
        </Field>
        <Field
          id="proxy-password"
          label="Password (optional)"
          hint="Leave as *** to keep the existing password."
        >
          <input
            id="proxy-password"
            type="password"
            autoComplete="off"
            value={values.password}
            onChange={(e) => {
              setPwdTouched(true);
              setValues((v) => ({ ...v, password: e.target.value }));
            }}
            onFocus={() => {
              if (values.password === '***') {
                setValues((v) => ({ ...v, password: '' }));
              }
            }}
            className={inputClass}
          />
        </Field>
      </div>

      {banner ? <Banner kind={banner.kind}>{banner.msg}</Banner> : null}

      {testResult ? (
        <Banner kind={testResult.ok ? 'success' : 'error'}>
          {testResult.ok ? (
            <>
              <strong>OK</strong> — exit IP{' '}
              <span className="font-mono">{testResult.ip ?? '?'}</span>
              {testResult.country ? (
                <>
                  {' '}from <strong>{testResult.country}</strong>
                  {testResult.region ? ` / ${testResult.region}` : ''}
                  {testResult.city ? ` / ${testResult.city}` : ''}
                </>
              ) : null}
              {testResult.org ? <> · {testResult.org}</> : null}
              {testResult.country && testResult.country !== 'ID' ? (
                <p className="mt-1 text-xs">
                  ⚠️ This proxy exits in <strong>{testResult.country}</strong>,
                  not Indonesia. Tokopedia / Shopee will likely still block it.
                </p>
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
        <button type="submit" disabled={submitting} className={buttonPrimaryClass}>
          {submitting ? 'Saving…' : 'Save'}
        </button>
        <button
          type="button"
          onClick={onTest}
          disabled={testing || !values.server}
          className={buttonSecondaryClass}
        >
          {testing ? 'Testing…' : 'Test Connection'}
        </button>
      </div>
    </form>
  );
}

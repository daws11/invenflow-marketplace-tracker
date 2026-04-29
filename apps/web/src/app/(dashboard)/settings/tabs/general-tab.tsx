'use client';

// General tab — App URL, default cron schedules, time zone (PRD §11.1).

import { type FormEvent, useEffect, useState } from 'react';

import {
  Banner,
  Field,
  buttonPrimaryClass,
  inputClass,
} from '../_form-helpers';

interface GeneralValues {
  appUrl: string;
  timezone: string;
  defaultCronDibayar: string;
  defaultCronDikirim: string;
}

const DEFAULTS: GeneralValues = {
  appUrl: '',
  timezone: 'Asia/Jakarta',
  defaultCronDibayar: '0 10 * * 1-5',
  defaultCronDikirim: '0 14 * * 1-5',
};

export function GeneralTab() {
  const [values, setValues] = useState<GeneralValues>(DEFAULTS);
  const [loaded, setLoaded] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [banner, setBanner] = useState<
    { kind: 'success' | 'error'; msg: string } | null
  >(null);

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch('/api/settings');
        if (!res.ok) throw new Error('Failed to load settings');
        const data = await res.json();
        setValues({
          appUrl: data.appUrl ?? '',
          timezone: data.timezone ?? DEFAULTS.timezone,
          defaultCronDibayar:
            data.defaultCronDibayar ?? DEFAULTS.defaultCronDibayar,
          defaultCronDikirim:
            data.defaultCronDikirim ?? DEFAULTS.defaultCronDikirim,
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
      const res = await fetch('/api/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(values),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? 'Failed to save');
      }
      setBanner({ kind: 'success', msg: 'Saved.' });
    } catch (err) {
      setBanner({ kind: 'error', msg: (err as Error).message });
    } finally {
      setSubmitting(false);
    }
  }

  if (!loaded) {
    return <p className="text-sm text-neutral-500">Loading…</p>;
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <Field id="appUrl" label="App URL" hint="Public URL where this sidecar is reachable.">
        <input
          id="appUrl"
          type="url"
          required
          value={values.appUrl}
          placeholder="https://tracker.example.com"
          onChange={(e) => setValues((v) => ({ ...v, appUrl: e.target.value }))}
          className={inputClass}
        />
      </Field>

      <Field id="timezone" label="Time zone">
        <input
          id="timezone"
          type="text"
          value={values.timezone}
          onChange={(e) =>
            setValues((v) => ({ ...v, timezone: e.target.value }))
          }
          className={inputClass}
        />
      </Field>

      <Field
        id="defaultCronDibayar"
        label="Default cron — paid (dibayar) pass"
        hint="Cron expression. Default: 0 10 * * 1-5 (10:00 weekdays)."
      >
        <input
          id="defaultCronDibayar"
          type="text"
          value={values.defaultCronDibayar}
          onChange={(e) =>
            setValues((v) => ({ ...v, defaultCronDibayar: e.target.value }))
          }
          className={inputClass}
        />
      </Field>

      <Field
        id="defaultCronDikirim"
        label="Default cron — shipped (dikirim) pass"
        hint="Cron expression. Default: 0 14 * * 1-5 (14:00 weekdays)."
      >
        <input
          id="defaultCronDikirim"
          type="text"
          value={values.defaultCronDikirim}
          onChange={(e) =>
            setValues((v) => ({ ...v, defaultCronDikirim: e.target.value }))
          }
          className={inputClass}
        />
      </Field>

      {banner ? <Banner kind={banner.kind}>{banner.msg}</Banner> : null}

      <div>
        <button
          type="submit"
          disabled={submitting}
          className={buttonPrimaryClass}
        >
          {submitting ? 'Saving…' : 'Save'}
        </button>
      </div>
    </form>
  );
}

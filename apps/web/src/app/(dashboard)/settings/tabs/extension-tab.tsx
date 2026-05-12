'use client';

// Settings → Extension tab. Manages the API key the home-server Chrome scraper
// extension uses to authenticate to /api/ingest and /api/extension/accounts.
// The plaintext key is shown exactly once, right after generation; afterwards
// only a short prefix is displayed.

import { useEffect, useState } from 'react';

import {
  Banner,
  buttonPrimaryClass,
  buttonSecondaryClass,
} from '../_form-helpers';

export function ExtensionTab() {
  const [loaded, setLoaded] = useState(false);
  const [configured, setConfigured] = useState(false);
  const [prefix, setPrefix] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [newKey, setNewKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [banner, setBanner] = useState<
    { kind: 'success' | 'error'; msg: string } | null
  >(null);

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch('/api/settings/extension');
        if (!res.ok) throw new Error('Failed to load extension settings');
        const data = await res.json();
        setConfigured(Boolean(data.configured));
        setPrefix(typeof data.prefix === 'string' ? data.prefix : null);
      } catch (err) {
        setBanner({ kind: 'error', msg: (err as Error).message });
      } finally {
        setLoaded(true);
      }
    })();
  }, []);

  async function onGenerate() {
    if (
      configured &&
      !window.confirm(
        'Rotate the extension key? The current key stops working immediately and you must update the extension on the home server.',
      )
    ) {
      return;
    }
    setGenerating(true);
    setBanner(null);
    setNewKey(null);
    setCopied(false);
    try {
      const res = await fetch('/api/settings/extension', { method: 'POST' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? 'Failed to generate key');
      }
      const data = await res.json();
      const key = String(data.key);
      setNewKey(key);
      setConfigured(true);
      setPrefix(key.slice(0, 12));
      setBanner({
        kind: 'success',
        msg: 'New key generated. Copy it now — it will not be shown again.',
      });
    } catch (err) {
      setBanner({ kind: 'error', msg: (err as Error).message });
    } finally {
      setGenerating(false);
    }
  }

  async function onCopy() {
    if (!newKey) return;
    try {
      await navigator.clipboard.writeText(newKey);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  if (!loaded) return <p className="text-sm text-neutral-500">Loading…</p>;

  return (
    <div className="space-y-4">
      <div className="space-y-2 text-sm text-neutral-700">
        <p>
          The home-server Chrome extension scrapes Tokopedia &amp; Shopee
          purchase lists in a real browser and posts the orders to this app. It
          authenticates with the key below, sent as the{' '}
          <code>x-extension-key</code> header. Paste it into the extension&rsquo;s
          Options page along with this app&rsquo;s public URL.
        </p>
        <p className="text-neutral-500">
          Status:{' '}
          {configured ? (
            <>
              configured
              {prefix ? (
                <>
                  {' '}
                  — <code>{prefix}…</code>
                </>
              ) : null}
            </>
          ) : (
            'not configured yet'
          )}
        </p>
      </div>

      {banner ? <Banner kind={banner.kind}>{banner.msg}</Banner> : null}

      {newKey ? (
        <div className="space-y-2 rounded-md border border-amber-200 bg-amber-50 p-3">
          <p className="text-sm font-medium text-amber-800">
            Copy this key now — it won&rsquo;t be shown again:
          </p>
          <code className="block break-all rounded bg-white p-2 text-xs text-neutral-800">
            {newKey}
          </code>
          <button
            type="button"
            onClick={onCopy}
            className={buttonSecondaryClass}
          >
            {copied ? 'Copied!' : 'Copy'}
          </button>
        </div>
      ) : null}

      <button
        type="button"
        onClick={onGenerate}
        disabled={generating}
        className={buttonPrimaryClass}
      >
        {generating
          ? 'Generating…'
          : configured
            ? 'Rotate key'
            : 'Generate key'}
      </button>
    </div>
  );
}

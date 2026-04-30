'use client';

// AI Model tab — provider, model, API key, base URL, temperature, max retries
// (PRD §7.9 / §11.2). NO hardcoded model identifiers in the UI: the model
// field is free-text. The provider dropdown's options are listed here only
// because they are a closed enum of supported provider dispatch branches in
// `lib/ai-config.ts` — adding a new provider requires backend code anyway.

import { type FormEvent, useEffect, useState } from 'react';

import {
  Banner,
  Field,
  buttonPrimaryClass,
  buttonSecondaryClass,
  inputClass,
} from '../_form-helpers';

type Provider =
  | 'anthropic'
  | 'openai'
  | 'google'
  | 'openai_compatible'
  | 'openrouter';

const OPENROUTER_DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';

interface AiValues {
  provider: Provider;
  model: string;
  apiKey: string; // '***' when fetched from server and a key is set
  baseUrl: string;
  temperature: number;
  maxRetries: number;
}

const INITIAL: AiValues = {
  provider: 'anthropic',
  model: '',
  apiKey: '',
  baseUrl: '',
  temperature: 0,
  maxRetries: 3,
};

interface TestResult {
  ok: boolean;
  model: string;
  provider: string;
  responsePreview?: string;
  error?: string;
}

export function AiTab() {
  const [values, setValues] = useState<AiValues>(INITIAL);
  const [loaded, setLoaded] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [testing, setTesting] = useState(false);
  const [banner, setBanner] = useState<
    { kind: 'success' | 'error'; msg: string } | null
  >(null);
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [keyTouched, setKeyTouched] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch('/api/settings/ai');
        if (!res.ok) throw new Error('Failed to load AI settings');
        const data = await res.json();
        if (data.configured) {
          setValues({
            provider: data.provider as Provider,
            model: data.model ?? '',
            apiKey: '***',
            baseUrl: data.baseUrl ?? '',
            temperature:
              typeof data.temperature === 'number' ? data.temperature : 0,
            maxRetries:
              typeof data.maxRetries === 'number' ? data.maxRetries : 3,
          });
        }
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
        provider: values.provider,
        model: values.model,
        baseUrl: values.baseUrl,
        temperature: values.temperature,
        maxRetries: values.maxRetries,
      };
      // Only send apiKey if the user typed a new one (not the masked '***').
      if (keyTouched && values.apiKey && values.apiKey !== '***') {
        payload.apiKey = values.apiKey;
      }
      const res = await fetch('/api/settings/ai', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? 'Failed to save');
      }
      setBanner({ kind: 'success', msg: 'Saved.' });
      setKeyTouched(false);
      setValues((v) => ({ ...v, apiKey: '***' }));
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
      // If the user hasn't typed a new key, send no body — server falls back
      // to the saved settings. Otherwise, send the form values.
      const body: Record<string, unknown> = {};
      if (keyTouched && values.apiKey && values.apiKey !== '***') {
        body.provider = values.provider;
        body.model = values.model;
        body.apiKey = values.apiKey;
        if (values.baseUrl) body.baseUrl = values.baseUrl;
      }
      const res = await fetch('/api/settings/ai/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = (await res.json()) as TestResult;
      setTestResult(data);
    } catch (err) {
      setTestResult({
        ok: false,
        model: values.model,
        provider: values.provider,
        error: (err as Error).message,
      });
    } finally {
      setTesting(false);
    }
  }

  if (!loaded) return <p className="text-sm text-neutral-500">Loading…</p>;

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <Field id="provider" label="Provider">
        <select
          id="provider"
          value={values.provider}
          onChange={(e) => {
            const next = e.target.value as Provider;
            setValues((v) => {
              // When the operator switches TO OpenRouter and the baseUrl
              // field is empty, pre-fill it with OR's canonical endpoint so
              // they don't have to remember it. Don't overwrite a non-empty
              // value (e.g. they pasted a self-hosted proxy).
              const baseUrl =
                next === 'openrouter' && !v.baseUrl
                  ? OPENROUTER_DEFAULT_BASE_URL
                  : v.baseUrl;
              return { ...v, provider: next, baseUrl };
            });
          }}
          className={inputClass}
        >
          <option value="anthropic">Anthropic</option>
          <option value="openai">OpenAI</option>
          <option value="google">Google (Gemini)</option>
          <option value="openrouter">OpenRouter</option>
          <option value="openai_compatible">OpenAI-compatible (custom)</option>
        </select>
      </Field>

      <Field
        id="model"
        label="Model identifier"
        hint={
          values.provider === 'openrouter'
            ? 'OpenRouter model ID, e.g. anthropic/claude-3.5-sonnet, openai/gpt-4o-mini.'
            : 'Free-text — paste the model ID exactly as the provider documents it.'
        }
      >
        <input
          id="model"
          type="text"
          required
          value={values.model}
          onChange={(e) => setValues((v) => ({ ...v, model: e.target.value }))}
          className={inputClass}
        />
      </Field>

      <Field
        id="apiKey"
        label="API key"
        hint="Leave as *** to keep the existing key."
      >
        <input
          id="apiKey"
          type="password"
          autoComplete="off"
          value={values.apiKey}
          onChange={(e) => {
            setKeyTouched(true);
            setValues((v) => ({ ...v, apiKey: e.target.value }));
          }}
          onFocus={() => {
            // Clear the placeholder mask the moment the user focuses the field
            // so they aren't editing on top of '***'.
            if (values.apiKey === '***') {
              setValues((v) => ({ ...v, apiKey: '' }));
            }
          }}
          className={inputClass}
        />
      </Field>

      {values.provider === 'openai_compatible' ||
      values.provider === 'openrouter' ? (
        <Field
          id="baseUrl"
          label="Base URL"
          hint={
            values.provider === 'openrouter'
              ? 'Defaults to https://openrouter.ai/api/v1. Override only if you proxy OpenRouter through your own gateway.'
              : 'OpenAI-compatible endpoint (e.g. self-hosted Ollama, vLLM, LiteLLM, …).'
          }
        >
          <input
            id="baseUrl"
            type="url"
            value={values.baseUrl}
            placeholder={
              values.provider === 'openrouter'
                ? OPENROUTER_DEFAULT_BASE_URL
                : 'https://api.example.com/v1'
            }
            onChange={(e) =>
              setValues((v) => ({ ...v, baseUrl: e.target.value }))
            }
            className={inputClass}
          />
        </Field>
      ) : null}

      <div className="grid grid-cols-2 gap-4">
        <Field id="temperature" label="Temperature">
          <input
            id="temperature"
            type="number"
            step="0.1"
            min={0}
            max={2}
            value={values.temperature}
            onChange={(e) =>
              setValues((v) => ({
                ...v,
                temperature: Number(e.target.value),
              }))
            }
            className={inputClass}
          />
        </Field>
        <Field id="maxRetries" label="Max retries">
          <input
            id="maxRetries"
            type="number"
            min={0}
            max={10}
            value={values.maxRetries}
            onChange={(e) =>
              setValues((v) => ({
                ...v,
                maxRetries: Number(e.target.value),
              }))
            }
            className={inputClass}
          />
        </Field>
      </div>

      {banner ? <Banner kind={banner.kind}>{banner.msg}</Banner> : null}

      {testResult ? (
        <Banner kind={testResult.ok ? 'success' : 'error'}>
          {testResult.ok ? (
            <>
              <strong>OK</strong> — {testResult.provider} / {testResult.model}
              {testResult.responsePreview ? (
                <>: <span className="font-mono">{testResult.responsePreview}</span></>
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

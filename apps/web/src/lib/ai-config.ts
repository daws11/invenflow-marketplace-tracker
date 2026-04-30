// Runtime AI provider configuration resolver.
//
// CRITICAL (PRD §7.9 / §11.2): all model identifiers come from the database
// at runtime. NO hardcoded model strings anywhere in this file or its
// callers. Initial seed values are pulled from env vars at first boot only
// (see `prisma/seed.ts`); after that everything flows through the
// `AiSettings` table.
//
// This module exposes three operations:
//   - `getActiveAiSettings()`        — load + decrypt the active row.
//   - `buildStagehandConfig()`       — produce a config blob shaped for a
//                                       Stagehand constructor (Stagehand is
//                                       NOT imported here; that lands later).
//   - `testAiConnection()`           — fire a minimal "Reply with just OK"
//                                       prompt against the configured model
//                                       and report the result. No DB writes.
//
// All HTTP calls use plain `fetch()` with a 10s `AbortController` timeout to
// avoid pulling in a vendor SDK.

import { prisma } from '@/lib/db';
import { decrypt } from '@/lib/encryption';

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export type AiProvider =
  | 'anthropic'
  | 'openai'
  | 'google'
  | 'openai_compatible'
  | 'openrouter';

/** Default base URL for OpenRouter — exposed so the UI can pre-fill it. */
export const OPENROUTER_DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';

export interface ActiveAiSettings {
  id: string;
  provider: AiProvider;
  model: string;
  /** Decrypted plaintext API key. */
  apiKey: string;
  baseUrl: string | null;
  temperature: number;
  maxRetries: number;
}

/**
 * Inputs accepted by the persistence layer (PATCH /api/settings/ai) and as
 * an optional override for `testAiConnection()`. Plain values — no
 * encryption concerns; the route encrypts before writing.
 */
export interface AiSettingsInput {
  provider: AiProvider;
  model: string;
  apiKey: string;
  baseUrl?: string | null;
  temperature?: number;
  maxRetries?: number;
}

export interface StagehandConfig {
  modelName: string;
  modelClientOptions: {
    apiKey: string;
    baseURL?: string;
  };
  /**
   * Stagehand exposes provider-level fields too; we forward what we have.
   * Kept loose so future Stagehand options don't require changing this
   * helper's call-sites.
   */
  provider: AiProvider;
  temperature: number;
  maxRetries: number;
}

export interface TestConnectionResult {
  ok: boolean;
  model: string;
  provider: string;
  responsePreview?: string;
  error?: string;
}

// -----------------------------------------------------------------------------
// Validation helpers
// -----------------------------------------------------------------------------

const VALID_PROVIDERS: ReadonlySet<AiProvider> = new Set<AiProvider>([
  'anthropic',
  'openai',
  'google',
  'openai_compatible',
  'openrouter',
]);

function assertProvider(value: string): AiProvider {
  if (VALID_PROVIDERS.has(value as AiProvider)) return value as AiProvider;
  throw new Error(
    `Unknown AI provider '${value}' — expected one of: ${[...VALID_PROVIDERS].join(', ')}`,
  );
}

// -----------------------------------------------------------------------------
// DB-backed lookups
// -----------------------------------------------------------------------------

/**
 * Loads the single `isActive=true` AiSettings row. Throws if none exists or
 * if no row is active (callers — e.g. the worker — should treat this as a
 * fatal misconfiguration; the operator must visit /settings to fix it).
 */
export async function getActiveAiSettings(): Promise<ActiveAiSettings> {
  const row = await prisma.aiSettings.findFirst({
    where: { isActive: true },
    orderBy: { updatedAt: 'desc' },
  });
  if (!row) {
    throw new Error(
      'No active AiSettings row found. Configure an AI model in the Settings UI.',
    );
  }

  return {
    id: row.id,
    provider: assertProvider(row.provider),
    model: row.model,
    apiKey: decrypt(row.apiKey),
    baseUrl: row.baseUrl,
    temperature: row.temperature,
    maxRetries: row.maxRetries,
  };
}

/**
 * Returns a Stagehand-shaped config object built from the active row. This
 * does NOT import Stagehand — keeping the AI module decoupled from the
 * worker dependency. The fields named here match Stagehand's documented
 * `Stagehand({ ... })` constructor; the worker will hand the object straight
 * through.
 */
export async function buildStagehandConfig(): Promise<StagehandConfig> {
  const s = await getActiveAiSettings();
  const modelClientOptions: StagehandConfig['modelClientOptions'] = {
    apiKey: s.apiKey,
  };
  // Resolve base URL: explicit value wins, otherwise OpenRouter gets its
  // canonical default (so operators don't have to remember to paste it).
  if (s.baseUrl) {
    modelClientOptions.baseURL = s.baseUrl;
  } else if (s.provider === 'openrouter') {
    modelClientOptions.baseURL = OPENROUTER_DEFAULT_BASE_URL;
  }

  return {
    modelName: s.model,
    modelClientOptions,
    provider: s.provider,
    temperature: s.temperature,
    maxRetries: s.maxRetries,
  };
}

// -----------------------------------------------------------------------------
// Test connection
// -----------------------------------------------------------------------------

const TEST_PROMPT = 'Reply with just the word OK.';
const TEST_TIMEOUT_MS = 10_000;
const TEST_MAX_TOKENS = 16;
const PREVIEW_LEN = 100;

/**
 * Sends the minimal validation prompt against the resolved configuration.
 * Returns `{ ok: true, responsePreview }` on success or `{ ok: false, error }`
 * on failure. No DB writes — purely for the "Test Connection" button.
 */
export async function testAiConnection(
  overrides?: Partial<AiSettingsInput>,
): Promise<TestConnectionResult> {
  // Resolve effective config — start with overrides; fill gaps from DB if any.
  let cfg: AiSettingsInput;
  try {
    if (
      overrides &&
      overrides.provider &&
      overrides.model &&
      overrides.apiKey
    ) {
      cfg = {
        provider: overrides.provider,
        model: overrides.model,
        apiKey: overrides.apiKey,
        baseUrl: overrides.baseUrl ?? null,
        temperature: overrides.temperature,
        maxRetries: overrides.maxRetries,
      };
    } else {
      const active = await getActiveAiSettings();
      cfg = {
        provider: overrides?.provider ?? active.provider,
        model: overrides?.model ?? active.model,
        apiKey: overrides?.apiKey ?? active.apiKey,
        baseUrl: overrides?.baseUrl ?? active.baseUrl,
        temperature: overrides?.temperature ?? active.temperature,
        maxRetries: overrides?.maxRetries ?? active.maxRetries,
      };
    }
  } catch (err) {
    return {
      ok: false,
      model: overrides?.model ?? '',
      provider: overrides?.provider ?? '',
      error: (err as Error).message,
    };
  }

  try {
    const text = await dispatch(cfg);
    return {
      ok: true,
      model: cfg.model,
      provider: cfg.provider,
      responsePreview: text.slice(0, PREVIEW_LEN),
    };
  } catch (err) {
    return {
      ok: false,
      model: cfg.model,
      provider: cfg.provider,
      error: (err as Error).message,
    };
  }
}

// -----------------------------------------------------------------------------
// Provider dispatch (raw fetch, no SDKs)
// -----------------------------------------------------------------------------

async function dispatch(cfg: AiSettingsInput): Promise<string> {
  switch (cfg.provider) {
    case 'anthropic':
      return callAnthropic(cfg);
    case 'openai':
    case 'openai_compatible':
      return callOpenAi(cfg);
    case 'openrouter':
      return callOpenAi({
        ...cfg,
        // OpenRouter accepts the OpenAI chat-completions shape verbatim.
        // Force the canonical baseUrl when the operator left it blank, and
        // forward the recommended attribution headers so OR can credit usage
        // to this app (and unlock app-specific routing rules later).
        baseUrl:
          cfg.baseUrl && cfg.baseUrl.length > 0
            ? cfg.baseUrl
            : OPENROUTER_DEFAULT_BASE_URL,
      }, OPENROUTER_HEADERS);
    case 'google':
      return callGoogle(cfg);
    default: {
      // exhaustive guard — TS will flag if a new provider is added.
      const _exhaustive: never = cfg.provider;
      throw new Error(`Unsupported provider: ${_exhaustive as string}`);
    }
  }
}

/**
 * OpenRouter "recommended" headers — they're optional but help with
 * attribution + may unlock cheaper / better routing. We don't read APP_URL
 * here to keep this module DB-free; the values below are static.
 */
const OPENROUTER_HEADERS: Record<string, string> = {
  'HTTP-Referer': 'https://tracker.ptunicorn.id',
  'X-Title': 'InvenFlow Marketplace Tracker',
};

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function readErrorBody(res: Response): Promise<string> {
  try {
    const text = await res.text();
    return text.slice(0, 500);
  } catch {
    return '';
  }
}

async function callAnthropic(cfg: AiSettingsInput): Promise<string> {
  const res = await fetchWithTimeout(
    'https://api.anthropic.com/v1/messages',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': cfg.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: cfg.model,
        max_tokens: TEST_MAX_TOKENS,
        messages: [{ role: 'user', content: TEST_PROMPT }],
      }),
    },
    TEST_TIMEOUT_MS,
  );

  if (!res.ok) {
    throw new Error(
      `Anthropic API error ${res.status}: ${await readErrorBody(res)}`,
    );
  }
  const json = (await res.json()) as {
    content?: Array<{ type?: string; text?: string }>;
  };
  const first = json.content?.[0];
  if (!first || typeof first.text !== 'string') {
    throw new Error('Anthropic API returned no text content');
  }
  return first.text;
}

async function callOpenAi(
  cfg: AiSettingsInput,
  extraHeaders?: Record<string, string>,
): Promise<string> {
  const base =
    (cfg.baseUrl && cfg.baseUrl.length > 0
      ? cfg.baseUrl
      : 'https://api.openai.com/v1'
    ).replace(/\/+$/, '');

  const res = await fetchWithTimeout(
    `${base}/chat/completions`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.apiKey}`,
        ...(extraHeaders ?? {}),
      },
      body: JSON.stringify({
        model: cfg.model,
        max_tokens: TEST_MAX_TOKENS,
        messages: [{ role: 'user', content: TEST_PROMPT }],
      }),
    },
    TEST_TIMEOUT_MS,
  );

  if (!res.ok) {
    throw new Error(
      `OpenAI-compatible API error ${res.status}: ${await readErrorBody(res)}`,
    );
  }
  const json = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const text = json.choices?.[0]?.message?.content;
  if (typeof text !== 'string') {
    throw new Error('OpenAI-compatible API returned no message content');
  }
  return text;
}

async function callGoogle(cfg: AiSettingsInput): Promise<string> {
  const url =
    'https://generativelanguage.googleapis.com/v1beta/models/' +
    `${encodeURIComponent(cfg.model)}:generateContent?key=` +
    encodeURIComponent(cfg.apiKey);

  const res = await fetchWithTimeout(
    url,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: TEST_PROMPT }] }],
      }),
    },
    TEST_TIMEOUT_MS,
  );

  if (!res.ok) {
    throw new Error(
      `Google Gemini API error ${res.status}: ${await readErrorBody(res)}`,
    );
  }
  const json = (await res.json()) as {
    candidates?: Array<{
      content?: { parts?: Array<{ text?: string }> };
    }>;
  };
  const text = json.candidates?.[0]?.content?.parts?.[0]?.text;
  if (typeof text !== 'string') {
    throw new Error('Google Gemini API returned no text content');
  }
  return text;
}

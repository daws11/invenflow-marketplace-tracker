// Worker-side AI configuration resolver. Mirrors
// apps/web/src/lib/ai-config.ts but exposes ONLY the read paths the worker
// needs: `getActiveAiSettings()` and `buildStagehandConfig()`. The
// `testAiConnection()` helper is intentionally web-only — no scrape pass
// should ever pop a connection-test prompt of its own.
//
// CRITICAL (PRD §7.9 / §11.2): no hardcoded model strings. The model name
// flows from the AiSettings row at runtime. The Stagehand factory consumes
// the result of buildStagehandConfig() and hands it straight to the
// constructor.
//
// Sharing decision (C1): Option B — duplicated in worker. See db.ts for the
// rationale. The two files must agree on field names + decryption
// behavior; if the web copy changes, mirror the change here.

import { prisma } from './db.js';
import { decrypt } from './encryption.js';

export type AiProvider =
  | 'anthropic'
  | 'openai'
  | 'google'
  | 'openai_compatible';

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

export interface StagehandConfig {
  modelName: string;
  modelClientOptions: {
    apiKey: string;
    baseURL?: string;
  };
  provider: AiProvider;
  temperature: number;
  maxRetries: number;
}

const VALID_PROVIDERS: ReadonlySet<AiProvider> = new Set<AiProvider>([
  'anthropic',
  'openai',
  'google',
  'openai_compatible',
]);

function assertProvider(value: string): AiProvider {
  if (VALID_PROVIDERS.has(value as AiProvider)) return value as AiProvider;
  throw new Error(
    `Unknown AI provider '${value}' — expected one of: ${[...VALID_PROVIDERS].join(', ')}`,
  );
}

/**
 * Loads the single `isActive=true` AiSettings row. Throws if none exists or
 * if no row is active (the operator must visit /settings to fix it).
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
 * Returns a Stagehand-shaped config object built from the active row.
 * The shape matches what `new Stagehand({...})` accepts: `modelName` and
 * `modelClientOptions`. Provider, temperature, and maxRetries are returned
 * alongside so the factory can apply them where Stagehand exposes hooks.
 */
export async function buildStagehandConfig(): Promise<StagehandConfig> {
  const s = await getActiveAiSettings();
  const modelClientOptions: StagehandConfig['modelClientOptions'] = {
    apiKey: s.apiKey,
  };
  if (s.baseUrl) modelClientOptions.baseURL = s.baseUrl;

  return {
    modelName: s.model,
    modelClientOptions,
    provider: s.provider,
    temperature: s.temperature,
    maxRetries: s.maxRetries,
  };
}

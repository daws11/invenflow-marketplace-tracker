// Worker-side InvenflowClient factory.
//
// Loads `invenflow.baseUrl` (plaintext) and `invenflow.serviceToken`
// (encrypted) from the `Setting` table, decrypts the token, and returns a
// configured `InvenflowClient`. Throws `InvenflowConfigError` if either
// setting is missing — the scrape-paid processor surfaces this as a
// run-failure with a clear "configure InvenFlow connection in Settings"
// error message.
//
// PRD §11.3 — InvenFlow Connection settings live in the per-key `Setting`
// table; the Settings UI (apps/web) is the only writer.

import { InvenflowClient } from './invenflow-client.js';
import { getSetting, SETTING_KEYS } from './settings.js';

/** Thrown when InvenFlow connection settings are not configured. */
export class InvenflowConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvenflowConfigError';
  }
}

/**
 * Builds an InvenflowClient from the persisted settings. Caller does not
 * cache — each scrape run pulls fresh settings so that a token rotation in
 * the UI is picked up by the next run without restarting the worker.
 */
export async function getInvenflowClient(): Promise<InvenflowClient> {
  const baseUrl = await getSetting<string>(SETTING_KEYS.invenflowBaseUrl);
  if (!baseUrl || typeof baseUrl !== 'string' || baseUrl.length === 0) {
    throw new InvenflowConfigError(
      'InvenFlow base URL is not configured. Set it in Settings → InvenFlow Connection.',
    );
  }

  const serviceToken = await getSetting<string>(
    SETTING_KEYS.invenflowServiceToken,
  );
  if (
    !serviceToken ||
    typeof serviceToken !== 'string' ||
    serviceToken.length === 0
  ) {
    throw new InvenflowConfigError(
      'InvenFlow service token is not configured. Set it in Settings → InvenFlow Connection.',
    );
  }

  return new InvenflowClient({ baseUrl, serviceToken });
}

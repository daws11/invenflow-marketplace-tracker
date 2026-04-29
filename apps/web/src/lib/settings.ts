// Generic key-value settings backed by the `Setting` Prisma model.
//
// Per PRD §11 / §12: app config (general, InvenFlow connection, Fonnte,
// per-event notification toggles) lives in this table. Values are
// JSON-serialized so we can store strings, numbers, booleans, and small
// objects under a single column. When a setting holds a secret (API key,
// service token, …) we run the JSON blob through AES-256-GCM via
// `lib/encryption.ts` and flip the `isSecret` flag so reads decrypt
// transparently.
//
// Magic strings for setting keys live in `SETTING_KEYS` so the rest of the
// app imports a typed identifier rather than spreading literals around.

import { prisma } from '@/lib/db';
import { decrypt, encrypt } from '@/lib/encryption';

// -----------------------------------------------------------------------------
// Canonical setting keys
// -----------------------------------------------------------------------------

export const SETTING_KEYS = {
  appUrl: 'app.url',
  defaultCronDibayar: 'cron.default.dibayar',
  defaultCronDikirim: 'cron.default.dikirim',
  timezone: 'app.timezone',
  invenflowBaseUrl: 'invenflow.baseUrl',
  invenflowServiceToken: 'invenflow.serviceToken', // secret
  fonnteToken: 'fonnte.token', // secret
  fonnteTarget: 'fonnte.target',
  notifyOnRunStart: 'notify.runStart',
  notifyOnRunSuccess: 'notify.runSuccess',
  notifyOnRunFail: 'notify.runFail',
  notifyOnLoginRequired: 'notify.loginRequired',
  notifyOnSessionExpired: 'notify.sessionExpired',
} as const;

export type SettingKey = (typeof SETTING_KEYS)[keyof typeof SETTING_KEYS];

/**
 * The default set of secret keys. `setSetting` will refuse to write one of
 * these in plaintext (silently flips `isSecret` on if not provided), so a
 * caller forgetting the flag can never accidentally store an API key
 * unencrypted.
 */
const SECRET_KEYS: ReadonlySet<string> = new Set<string>([
  SETTING_KEYS.invenflowServiceToken,
  SETTING_KEYS.fonnteToken,
]);

// -----------------------------------------------------------------------------
// Reads / writes
// -----------------------------------------------------------------------------

/**
 * Reads a setting. Returns `null` if the row does not exist.
 *
 * Values are stored as JSON; secrets are decrypted before parsing. The caller
 * is responsible for the type parameter — there is no runtime validation.
 */
export async function getSetting<T = unknown>(key: string): Promise<T | null> {
  const row = await prisma.setting.findUnique({ where: { key } });
  if (!row) return null;

  const json = row.isSecret ? decrypt(row.value) : row.value;
  try {
    return JSON.parse(json) as T;
  } catch (err) {
    throw new Error(
      `Setting '${key}' contains invalid JSON: ${(err as Error).message}`,
    );
  }
}

/**
 * Writes (upserts) a setting. JSON-serializes the value and encrypts it when
 * `isSecret` is true (or when the key is in the well-known SECRET_KEYS set).
 */
export async function setSetting<T>(
  key: string,
  value: T,
  isSecret?: boolean,
): Promise<void> {
  const secret = isSecret ?? SECRET_KEYS.has(key);
  const json = JSON.stringify(value);
  const stored = secret ? encrypt(json) : json;

  await prisma.setting.upsert({
    where: { key },
    update: { value: stored, isSecret: secret },
    create: { key, value: stored, isSecret: secret },
  });
}

/**
 * Returns true when a setting row exists. Useful for "is this secret set?"
 * UI queries that don't want the plaintext value (e.g. masking with `***`
 * in the Settings form).
 */
export async function hasSetting(key: string): Promise<boolean> {
  const row = await prisma.setting.findUnique({ where: { key } });
  return row !== null;
}

/**
 * Bulk fetch — convenience for the GET /api/settings handler. Reads one
 * round-trip rather than N. Returns a `Map<key, parsedValue>`. Secret values
 * are decrypted; if you only want to know whether a secret is set, use
 * `hasSetting()` instead.
 */
export async function getSettings(
  keys: readonly string[],
): Promise<Map<string, unknown>> {
  if (keys.length === 0) return new Map();
  const rows = await prisma.setting.findMany({
    where: { key: { in: [...keys] } },
  });
  const result = new Map<string, unknown>();
  for (const row of rows) {
    const json = row.isSecret ? decrypt(row.value) : row.value;
    try {
      result.set(row.key, JSON.parse(json));
    } catch (err) {
      throw new Error(
        `Setting '${row.key}' contains invalid JSON: ${(err as Error).message}`,
      );
    }
  }
  return result;
}

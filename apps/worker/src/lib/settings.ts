// Generic key-value settings backed by the `Setting` Prisma model.
// Worker-side mirror of `apps/web/src/lib/settings.ts`.
//
// Sharing decision (C3a): Option B — duplicated in worker. The web copy
// stays canonical; if it changes, mirror the change here. Both copies must
// agree on key names + secret-encryption behavior because rows written by
// the web (Settings UI) are read by the worker (this file) at scrape time.

import { prisma } from './db.js';
import { decrypt, encrypt } from './encryption.js';

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

const SECRET_KEYS: ReadonlySet<string> = new Set<string>([
  SETTING_KEYS.invenflowServiceToken,
  SETTING_KEYS.fonnteToken,
]);

// -----------------------------------------------------------------------------
// Reads / writes
// -----------------------------------------------------------------------------

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

export async function hasSetting(key: string): Promise<boolean> {
  const row = await prisma.setting.findUnique({ where: { key } });
  return row !== null;
}

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

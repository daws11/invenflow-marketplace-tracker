// GET / POST /api/settings/extension — manage the Chrome-extension API key.
//
// The key authenticates the home-server scraper extension to `/api/ingest` and
// `/api/extension/accounts` (via the `x-extension-key` header). We only ever
// store its SHA-256 hash plus a short prefix (for display); POST generates a
// fresh key, replaces the stored hash, and returns the plaintext exactly once.
// Session-authenticated — this is an admin-UI surface, not an extension one.

import { createHash, randomBytes } from 'node:crypto';

import { NextResponse } from 'next/server';

import { getCurrentUser } from '@/lib/auth';
import {
  SETTING_KEYS,
  getSetting,
  hasSetting,
  setSetting,
} from '@/lib/settings';

export const dynamic = 'force-dynamic';

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function unauthorized(): NextResponse {
  return NextResponse.json(
    { error: 'Unauthorized', code: 'UNAUTHORIZED' },
    { status: 401 },
  );
}

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return unauthorized();

  const [configured, prefix] = await Promise.all([
    hasSetting(SETTING_KEYS.extensionApiKeyHash),
    getSetting<string>(SETTING_KEYS.extensionApiKeyPrefix),
  ]);
  return NextResponse.json({
    configured,
    prefix: configured ? (prefix ?? null) : null,
  });
}

export async function POST() {
  const user = await getCurrentUser();
  if (!user) return unauthorized();

  const key = `ext_${randomBytes(32).toString('hex')}`;
  await setSetting(SETTING_KEYS.extensionApiKeyHash, sha256Hex(key), false);
  await setSetting(SETTING_KEYS.extensionApiKeyPrefix, key.slice(0, 12), false);

  // Returned in plaintext exactly once; the server never stores it.
  return NextResponse.json({ key });
}

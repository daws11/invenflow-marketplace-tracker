// Bearer-key auth for the home-server Chrome scraper extension endpoints.
//
// The extension scrapes Tokopedia/Shopee buyer purchase lists in a real
// browser (server-side automation is blocked by the marketplaces' anti-bot)
// and POSTs the parsed orders to `/api/ingest`, reading per-account config
// from `/api/extension/accounts`. Those routes can't ride the NextAuth session
// cookie, so they authenticate with a dedicated key: the extension sends it in
// the `x-extension-key` request header and we compare its SHA-256 against the
// hash stored in the `Setting` table (generated / rotated from
// Settings → Extension).

import { createHash, timingSafeEqual } from 'node:crypto';

import { NextResponse } from 'next/server';

import { SETTING_KEYS, getSetting } from '@/lib/settings';

const EXTENSION_KEY_HEADER = 'x-extension-key';

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function unauthorized(): NextResponse {
  return NextResponse.json(
    { error: 'Unauthorized', code: 'UNAUTHORIZED' },
    { status: 401 },
  );
}

/**
 * Validates the `x-extension-key` header against the stored key hash.
 *
 * Returns a `401` `NextResponse` (contract envelope) when the header is
 * missing or invalid, or when no extension key has been generated yet.
 * Returns `null` when the request is authorized — callers do:
 *
 *   const unauth = await requireExtensionKey(req);
 *   if (unauth) return unauth;
 */
export async function requireExtensionKey(
  req: Request,
): Promise<NextResponse | null> {
  const provided = req.headers.get(EXTENSION_KEY_HEADER);
  const storedHash = await getSetting<string>(
    SETTING_KEYS.extensionApiKeyHash,
  );
  if (!provided || !storedHash) return unauthorized();

  const providedHash = Buffer.from(sha256Hex(provided), 'hex');
  const expectedHash = Buffer.from(storedHash, 'hex');
  if (
    providedHash.length === 0 ||
    providedHash.length !== expectedHash.length ||
    !timingSafeEqual(providedHash, expectedHash)
  ) {
    return unauthorized();
  }
  return null;
}

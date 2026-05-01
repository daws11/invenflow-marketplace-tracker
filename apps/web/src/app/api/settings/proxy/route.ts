// GET / PATCH /api/settings/proxy — outbound HTTP proxy used by the worker's
// Chromium launches. Lets the operator route browser sessions through an
// Indonesian residential / mobile proxy while the VPS itself stays in
// Europe; without this the marketplace login pages return Cloudflare
// challenges or hard-block the EU IP.
//
// Read returns the password masked as '***' if set. Writes treat '***' /
// empty string as "leave existing value untouched", matching the AI tab
// pattern. PATCH accepts a partial body — fields not provided are not
// touched. Sending `enabled: false` is allowed without the other fields.

import { NextResponse } from 'next/server';
import { z } from 'zod';

import { getCurrentUser } from '@/lib/auth';
import { SETTING_KEYS, getSettings, setSetting } from '@/lib/settings';

export const dynamic = 'force-dynamic';

const ProxyPatchSchema = z
  .object({
    enabled: z.boolean().optional(),
    server: z
      .union([z.string().url(), z.literal('')])
      .optional()
      .transform((v) => (typeof v === 'string' ? v.trim() : v)),
    username: z.string().optional(),
    password: z.string().optional(),
  })
  .strict();

function isMaskedOrEmpty(v: string | undefined): boolean {
  if (v === undefined) return true;
  const t = v.trim();
  return t.length === 0 || t === '***';
}

export async function GET() {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const map = await getSettings([
    SETTING_KEYS.proxyEnabled,
    SETTING_KEYS.proxyServer,
    SETTING_KEYS.proxyUsername,
    SETTING_KEYS.proxyPassword,
  ]);

  const password = map.get(SETTING_KEYS.proxyPassword);
  const passwordSet = typeof password === 'string' && password.length > 0;

  return NextResponse.json({
    enabled: Boolean(map.get(SETTING_KEYS.proxyEnabled)),
    server: typeof map.get(SETTING_KEYS.proxyServer) === 'string'
      ? (map.get(SETTING_KEYS.proxyServer) as string)
      : '',
    username: typeof map.get(SETTING_KEYS.proxyUsername) === 'string'
      ? (map.get(SETTING_KEYS.proxyUsername) as string)
      : '',
    password: passwordSet ? '***' : '',
    passwordSet,
  });
}

export async function PATCH(req: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const parsed = ProxyPatchSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid payload', details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const { enabled, server, username, password } = parsed.data;

  if (enabled !== undefined) {
    await setSetting(SETTING_KEYS.proxyEnabled, enabled);
  }
  if (server !== undefined) {
    await setSetting(SETTING_KEYS.proxyServer, server);
  }
  if (username !== undefined) {
    await setSetting(SETTING_KEYS.proxyUsername, username.trim());
  }
  // Treat '***' / empty string as "keep existing" — same UX pattern as the
  // AI tab. Operators editing the server URL never have to retype the
  // password they already saved.
  if (!isMaskedOrEmpty(password)) {
    await setSetting(SETTING_KEYS.proxyPassword, password!.trim());
  }

  return NextResponse.json({ ok: true });
}

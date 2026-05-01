// POST /api/settings/proxy/test — fetch ifconfig.io through the configured
// proxy and return the IP + geolocation as the response. Lets the operator
// verify their proxy actually exits in Indonesia before relying on it for a
// real marketplace login.
//
// Body shape (all optional — falls through to saved settings):
//   { server?: string, username?: string, password?: string }
//
// We use undici's ProxyAgent which is bundled with Node 20+, so no extra
// runtime dependency needed.

import { NextResponse } from 'next/server';
import { ProxyAgent, fetch as undiciFetch } from 'undici';
import { z } from 'zod';

import { getCurrentUser } from '@/lib/auth';
import { SETTING_KEYS, getSettings } from '@/lib/settings';

export const dynamic = 'force-dynamic';

const TestSchema = z
  .object({
    server: z
      .union([z.string().url(), z.literal('')])
      .optional()
      .transform((v) => (typeof v === 'string' ? v.trim() : v)),
    username: z.string().optional(),
    password: z.string().optional(),
  })
  .strict();

const TIMEOUT_MS = 15_000;

interface IpInfo {
  ip?: string;
  city?: string;
  region?: string;
  country?: string;
  org?: string;
  timezone?: string;
}

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let json: unknown = {};
  try {
    const text = await req.text();
    if (text && text.trim().length > 0) json = JSON.parse(text);
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const parsed = TestSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid payload', details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  // Resolve effective config: explicit overrides win, otherwise saved.
  let server = parsed.data.server;
  let username = parsed.data.username;
  let password = parsed.data.password;
  if (!server || (password === undefined && username === undefined)) {
    const map = await getSettings([
      SETTING_KEYS.proxyServer,
      SETTING_KEYS.proxyUsername,
      SETTING_KEYS.proxyPassword,
    ]);
    if (!server) {
      const saved = map.get(SETTING_KEYS.proxyServer);
      if (typeof saved === 'string') server = saved;
    }
    if (username === undefined) {
      const saved = map.get(SETTING_KEYS.proxyUsername);
      if (typeof saved === 'string') username = saved;
    }
    if (password === undefined) {
      const saved = map.get(SETTING_KEYS.proxyPassword);
      if (typeof saved === 'string') password = saved;
    }
  }

  if (!server || server.length === 0) {
    return NextResponse.json(
      { ok: false, error: 'Proxy server URL is not configured.' },
      { status: 400 },
    );
  }

  // Build the proxy URL. undici's ProxyAgent accepts credentials embedded
  // in the URL; that's the most reliable shape across HTTP/SOCKS proxies.
  let proxyUrl: string;
  try {
    const u = new URL(server);
    if (username) u.username = encodeURIComponent(username);
    if (password) u.password = encodeURIComponent(password);
    proxyUrl = u.toString();
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: `Proxy server URL is invalid: ${(err as Error).message}`,
      },
      { status: 400 },
    );
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const agent = new ProxyAgent(proxyUrl);
    const res = await undiciFetch('https://ipinfo.io/json', {
      dispatcher: agent,
      signal: controller.signal,
      headers: { 'user-agent': 'invenflow-tracker/proxy-test' },
    });
    if (!res.ok) {
      return NextResponse.json(
        {
          ok: false,
          error: `Proxy reachable but ipinfo.io returned ${res.status}`,
        },
        { status: 400 },
      );
    }
    const info = (await res.json()) as IpInfo;
    return NextResponse.json({
      ok: true,
      ip: info.ip ?? null,
      city: info.city ?? null,
      region: info.region ?? null,
      country: info.country ?? null,
      org: info.org ?? null,
      timezone: info.timezone ?? null,
    });
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: `Proxy request failed: ${(err as Error).message}`,
      },
      { status: 400 },
    );
  } finally {
    clearTimeout(timer);
  }
}

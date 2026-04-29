// GET / PATCH /api/settings — general settings (non-AI tabs).
//
// Returns and updates the key-value rows in the `Setting` table that the
// General, InvenFlow Connection, and Notifications tabs of the Settings UI
// edit. AI settings have their own route (`/api/settings/ai`) because the
// `AiSettings` model is structured.
//
// Security: secrets are never returned in plaintext. The shape always emits
// `'***'` for a secret that is set, and `null` for one that isn't. Writes
// accept new values via the request body; an empty string is treated as
// "no change" to support submitting forms that left the secret field blank.

import { NextResponse } from 'next/server';
import { z } from 'zod';

import { getCurrentUser } from '@/lib/auth';
import { SETTING_KEYS, getSettings, hasSetting, setSetting } from '@/lib/settings';

export const dynamic = 'force-dynamic';

// -----------------------------------------------------------------------------
// Read-side: assemble the settings the General/InvenFlow/Notifications tabs
// need. Secret values are masked.
// -----------------------------------------------------------------------------

interface SettingsResponse {
  appUrl: string | null;
  timezone: string | null;
  defaultCronDibayar: string | null;
  defaultCronDikirim: string | null;
  invenflowBaseUrl: string | null;
  invenflowServiceTokenSet: boolean;
  invenflowServiceToken: '***' | null;
  fonnteTokenSet: boolean;
  fonnteToken: '***' | null;
  fonnteTarget: string | null;
  notifyOnRunStart: boolean;
  notifyOnRunSuccess: boolean;
  notifyOnRunFail: boolean;
  notifyOnLoginRequired: boolean;
  notifyOnSessionExpired: boolean;
  notifyOnDailyDigest: boolean;
}

const NON_SECRET_KEYS = [
  SETTING_KEYS.appUrl,
  SETTING_KEYS.timezone,
  SETTING_KEYS.defaultCronDibayar,
  SETTING_KEYS.defaultCronDikirim,
  SETTING_KEYS.invenflowBaseUrl,
  SETTING_KEYS.fonnteTarget,
  SETTING_KEYS.notifyOnRunStart,
  SETTING_KEYS.notifyOnRunSuccess,
  SETTING_KEYS.notifyOnRunFail,
  SETTING_KEYS.notifyOnLoginRequired,
  SETTING_KEYS.notifyOnSessionExpired,
  SETTING_KEYS.notifyOnDailyDigest,
] as const;

function asString(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function asBool(v: unknown): boolean {
  return v === true;
}

export async function GET() {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const map = await getSettings(NON_SECRET_KEYS);
  const [invenflowSet, fonnteSet] = await Promise.all([
    hasSetting(SETTING_KEYS.invenflowServiceToken),
    hasSetting(SETTING_KEYS.fonnteToken),
  ]);

  const body: SettingsResponse = {
    appUrl: asString(map.get(SETTING_KEYS.appUrl)),
    timezone: asString(map.get(SETTING_KEYS.timezone)),
    defaultCronDibayar: asString(map.get(SETTING_KEYS.defaultCronDibayar)),
    defaultCronDikirim: asString(map.get(SETTING_KEYS.defaultCronDikirim)),
    invenflowBaseUrl: asString(map.get(SETTING_KEYS.invenflowBaseUrl)),
    invenflowServiceTokenSet: invenflowSet,
    invenflowServiceToken: invenflowSet ? '***' : null,
    fonnteTokenSet: fonnteSet,
    fonnteToken: fonnteSet ? '***' : null,
    fonnteTarget: asString(map.get(SETTING_KEYS.fonnteTarget)),
    notifyOnRunStart: asBool(map.get(SETTING_KEYS.notifyOnRunStart)),
    notifyOnRunSuccess: asBool(map.get(SETTING_KEYS.notifyOnRunSuccess)),
    notifyOnRunFail: asBool(map.get(SETTING_KEYS.notifyOnRunFail)),
    notifyOnLoginRequired: asBool(map.get(SETTING_KEYS.notifyOnLoginRequired)),
    notifyOnSessionExpired: asBool(map.get(SETTING_KEYS.notifyOnSessionExpired)),
    // Default ON: a missing row reads as `true` so a fresh install gets the
    // 6 PM digest without an explicit save.
    notifyOnDailyDigest:
      map.get(SETTING_KEYS.notifyOnDailyDigest) === undefined
        ? true
        : asBool(map.get(SETTING_KEYS.notifyOnDailyDigest)),
  };

  return NextResponse.json(body);
}

// -----------------------------------------------------------------------------
// Write-side: partial update via Zod validation. Secrets that arrive as the
// empty string or the literal mask string are ignored (treated as "no change").
// -----------------------------------------------------------------------------

const PatchSchema = z
  .object({
    appUrl: z.string().url().optional(),
    timezone: z.string().min(1).optional(),
    defaultCronDibayar: z.string().min(1).optional(),
    defaultCronDikirim: z.string().min(1).optional(),
    invenflowBaseUrl: z.string().url().optional(),
    invenflowServiceToken: z.string().optional(),
    fonnteToken: z.string().optional(),
    fonnteTarget: z.string().min(1).optional(),
    notifyOnRunStart: z.boolean().optional(),
    notifyOnRunSuccess: z.boolean().optional(),
    notifyOnRunFail: z.boolean().optional(),
    notifyOnLoginRequired: z.boolean().optional(),
    notifyOnSessionExpired: z.boolean().optional(),
    notifyOnDailyDigest: z.boolean().optional(),
  })
  .strict();

function isMaskedOrEmpty(v: string | undefined): boolean {
  if (v === undefined) return true;
  const t = v.trim();
  return t.length === 0 || t === '***';
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
    return NextResponse.json(
      { error: 'Invalid JSON body' },
      { status: 400 },
    );
  }

  const parsed = PatchSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid payload', details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const data = parsed.data;

  const writes: Promise<void>[] = [];

  if (data.appUrl !== undefined)
    writes.push(setSetting(SETTING_KEYS.appUrl, data.appUrl));
  if (data.timezone !== undefined)
    writes.push(setSetting(SETTING_KEYS.timezone, data.timezone));
  if (data.defaultCronDibayar !== undefined)
    writes.push(
      setSetting(SETTING_KEYS.defaultCronDibayar, data.defaultCronDibayar),
    );
  if (data.defaultCronDikirim !== undefined)
    writes.push(
      setSetting(SETTING_KEYS.defaultCronDikirim, data.defaultCronDikirim),
    );
  if (data.invenflowBaseUrl !== undefined)
    writes.push(
      setSetting(SETTING_KEYS.invenflowBaseUrl, data.invenflowBaseUrl),
    );

  if (!isMaskedOrEmpty(data.invenflowServiceToken)) {
    writes.push(
      setSetting(
        SETTING_KEYS.invenflowServiceToken,
        data.invenflowServiceToken!,
        true,
      ),
    );
  }
  if (!isMaskedOrEmpty(data.fonnteToken)) {
    writes.push(setSetting(SETTING_KEYS.fonnteToken, data.fonnteToken!, true));
  }
  if (data.fonnteTarget !== undefined)
    writes.push(setSetting(SETTING_KEYS.fonnteTarget, data.fonnteTarget));

  if (data.notifyOnRunStart !== undefined)
    writes.push(
      setSetting(SETTING_KEYS.notifyOnRunStart, data.notifyOnRunStart),
    );
  if (data.notifyOnRunSuccess !== undefined)
    writes.push(
      setSetting(SETTING_KEYS.notifyOnRunSuccess, data.notifyOnRunSuccess),
    );
  if (data.notifyOnRunFail !== undefined)
    writes.push(setSetting(SETTING_KEYS.notifyOnRunFail, data.notifyOnRunFail));
  if (data.notifyOnLoginRequired !== undefined)
    writes.push(
      setSetting(
        SETTING_KEYS.notifyOnLoginRequired,
        data.notifyOnLoginRequired,
      ),
    );
  if (data.notifyOnSessionExpired !== undefined)
    writes.push(
      setSetting(
        SETTING_KEYS.notifyOnSessionExpired,
        data.notifyOnSessionExpired,
      ),
    );
  if (data.notifyOnDailyDigest !== undefined)
    writes.push(
      setSetting(SETTING_KEYS.notifyOnDailyDigest, data.notifyOnDailyDigest),
    );

  await Promise.all(writes);

  return NextResponse.json({ ok: true });
}

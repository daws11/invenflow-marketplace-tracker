// POST /api/settings/notifications/test — send a test WhatsApp message via
// Fonnte using the currently-saved credentials.
//
// Returns `{ ok: true }` on success, `{ ok: false, error }` on failure.
// Treats a missing-config no-op as `{ ok: false, error: ... }` so the UI
// gives the operator a clear "set the token first" hint.

import { NextResponse } from 'next/server';

import { getCurrentUser } from '@/lib/auth';
import { FonnteClient } from '@/lib/fonnte';
import { SETTING_KEYS, getSetting } from '@/lib/settings';

export const dynamic = 'force-dynamic';

const TEST_MESSAGE =
  '[InvenFlow Tracker] Test message from Settings — if you see this, Fonnte is configured correctly.';

export async function POST() {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const [token, target] = await Promise.all([
    getSetting<string>(SETTING_KEYS.fonnteToken),
    getSetting<string>(SETTING_KEYS.fonnteTarget),
  ]);

  if (!token || !target) {
    return NextResponse.json(
      {
        ok: false,
        error:
          'Fonnte token or target is not configured. Set both in the Notifications tab and save before testing.',
      },
      { status: 400 },
    );
  }

  const client = new FonnteClient({ token, target });
  try {
    await client.sendMessage(TEST_MESSAGE);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message },
      { status: 502 },
    );
  }
}

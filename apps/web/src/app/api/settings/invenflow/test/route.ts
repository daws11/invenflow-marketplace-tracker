// POST /api/settings/invenflow/test — verify the saved InvenFlow connection.
//
// Calls `GET /api/health` on the configured InvenFlow instance using the
// configured service token. Returns `{ ok, response? }` on success or
// `{ ok: false, error }` on failure. Used by the "Test Connection" button on
// the InvenFlow tab of the Settings UI (PRD §11.3).

import { NextResponse } from 'next/server';

import { getCurrentUser } from '@/lib/auth';
import { InvenflowClient } from '@/lib/invenflow-client';
import { SETTING_KEYS, getSetting } from '@/lib/settings';

export const dynamic = 'force-dynamic';

export async function POST() {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const [baseUrl, token] = await Promise.all([
    getSetting<string>(SETTING_KEYS.invenflowBaseUrl),
    getSetting<string>(SETTING_KEYS.invenflowServiceToken),
  ]);

  if (!baseUrl || !token) {
    return NextResponse.json(
      {
        ok: false,
        error:
          'InvenFlow base URL or service token is not configured. Set both and save before testing.',
      },
      { status: 400 },
    );
  }

  const client = new InvenflowClient({ baseUrl, serviceToken: token });
  try {
    const response = await client.health();
    return NextResponse.json({ ok: true, response });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message },
      { status: 502 },
    );
  }
}

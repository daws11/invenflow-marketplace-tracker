// Internal proxy: GET /api/internal/invenflow/kanbans?type=order
//
// The Account-creation UI uses this to populate its kanban dropdown. We do
// the InvenFlow call server-side so the service token never reaches the
// browser. Contract §4.2 — `KanbanListResponse` shape is forwarded as-is on
// success; on any failure (settings missing, InvenFlow unreachable, 401, …)
// we return 502 with a contract-shape `{ error, code }` body so the client
// can render a clear "couldn't load kanbans" banner.
//
// Route handler is gated on `getCurrentUser()` (401 if not logged in).
//
// NOTE: this is NOT the public InvenFlow endpoint — it lives under
// `/api/internal/...` to make it explicit that it is a sidecar-internal
// helper bound to the user session, not a stable contract surface.

import { NextResponse } from 'next/server';

import { getCurrentUser } from '@/lib/auth';
import { InvenflowApiError, InvenflowClient } from '@/lib/invenflow-client';
import { SETTING_KEYS, getSetting } from '@/lib/settings';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json(
      { error: 'Unauthorized', code: 'UNAUTHORIZED' },
      { status: 401 },
    );
  }

  const url = new URL(req.url);
  const type = url.searchParams.get('type');
  if (type !== 'order' && type !== 'receive') {
    return NextResponse.json(
      {
        error: "query param 'type' must be 'order' or 'receive'",
        code: 'INVALID_PAYLOAD',
      },
      { status: 400 },
    );
  }

  let baseUrl: string | null;
  let serviceToken: string | null;
  try {
    [baseUrl, serviceToken] = await Promise.all([
      getSetting<string>(SETTING_KEYS.invenflowBaseUrl),
      getSetting<string>(SETTING_KEYS.invenflowServiceToken),
    ]);
  } catch (err) {
    return NextResponse.json(
      {
        error: 'Failed to read settings',
        code: 'SETTINGS_ERROR',
        details: { message: (err as Error).message },
      },
      { status: 502 },
    );
  }

  if (!baseUrl || !serviceToken) {
    return NextResponse.json(
      {
        error:
          'InvenFlow base URL and/or service token are not configured. Configure them in Settings → InvenFlow.',
        code: 'INVENFLOW_NOT_CONFIGURED',
      },
      { status: 502 },
    );
  }

  try {
    const client = new InvenflowClient({ baseUrl, serviceToken });
    const data = await client.listKanbans(type);
    return NextResponse.json(data);
  } catch (err) {
    if (err instanceof InvenflowApiError) {
      return NextResponse.json(
        {
          error: err.message,
          code: err.code ?? 'INVENFLOW_ERROR',
          details: { status: err.status },
        },
        { status: 502 },
      );
    }
    return NextResponse.json(
      {
        error: 'Failed to reach InvenFlow',
        code: 'INVENFLOW_UNREACHABLE',
        details: { message: (err as Error).message },
      },
      { status: 502 },
    );
  }
}

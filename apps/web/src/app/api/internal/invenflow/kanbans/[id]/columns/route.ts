// Internal proxy: GET /api/internal/invenflow/kanbans/[id]/columns
//
// Companion to the kanbans-list route — once the operator picks a kanban in
// the Add-Account form, the client calls this to populate the "column on
// paid" / "column on shipped" dropdowns. Contract §4.3 — `KanbanColumnsResponse`
// is forwarded verbatim on success; on any failure the response is 502 with
// a contract-shape `{ error, code }` body so the UI can show one banner.
//
// Auth-gated; service token stays server-side.

import { NextResponse } from 'next/server';

import { getCurrentUser } from '@/lib/auth';
import { InvenflowApiError, InvenflowClient } from '@/lib/invenflow-client';
import { SETTING_KEYS, getSetting } from '@/lib/settings';

export const dynamic = 'force-dynamic';

export async function GET(
  _req: Request,
  { params }: { params: { id: string } },
) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json(
      { error: 'Unauthorized', code: 'UNAUTHORIZED' },
      { status: 401 },
    );
  }

  const kanbanId = params.id?.trim();
  if (!kanbanId) {
    return NextResponse.json(
      { error: 'kanban id is required', code: 'INVALID_PAYLOAD' },
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
    const data = await client.listKanbanColumns(kanbanId);
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

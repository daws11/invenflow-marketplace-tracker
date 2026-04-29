// GET /api/accounts/[id]/browser/status?session={sessionId}
//
// Returns the current state of an interactive browser session. The UI
// polls this every 1s while a session is active; the response shape is
// stable so the client can render a state machine off it.
//
// Response:
//   { status, idleDeadlineAt, finalStatus?, errorMessage?, pollIntervalMs }
//
// 404 — session unknown (expired, never existed, or belongs to another
// account; we don't leak the difference).

import { NextResponse } from 'next/server';

import { getCurrentUser } from '@/lib/auth';
import { redis } from '@/lib/redis';
import { readSession } from '@/lib/session-state';

export const dynamic = 'force-dynamic';

const POLL_INTERVAL_MS = 1000;

export async function GET(
  req: Request,
  { params }: { params: { id: string } },
) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json(
      { error: 'Unauthorized', code: 'UNAUTHORIZED' },
      { status: 401 },
    );
  }

  const url = new URL(req.url);
  const sessionId = url.searchParams.get('session');
  if (!sessionId) {
    return NextResponse.json(
      { error: 'Missing ?session= query parameter.', code: 'INVALID_PAYLOAD' },
      { status: 400 },
    );
  }

  const rec = await readSession(redis, sessionId);
  if (!rec) {
    return NextResponse.json(
      { error: 'Session not found.', code: 'NOT_FOUND' },
      { status: 404 },
    );
  }
  if (rec.accountId !== params.id) {
    // Don't leak existence of another account's session.
    return NextResponse.json(
      { error: 'Session not found.', code: 'NOT_FOUND' },
      { status: 404 },
    );
  }

  return NextResponse.json({
    status: rec.status,
    idleDeadlineAt: rec.idleDeadlineAt,
    finalStatus: rec.finalStatus,
    errorMessage: rec.errorMessage,
    pollIntervalMs: POLL_INTERVAL_MS,
  });
}

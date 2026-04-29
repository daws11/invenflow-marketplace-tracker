// POST /api/accounts/[id]/browser/save
//
// Save-and-close the active interactive browser session for the given
// account. Sets `command=save` in Redis; the worker picks it up on its
// next 1s poll, navigates to a protected page to verify the login, then
// updates Account.status accordingly (PRD §7.3.2).
//
// 202 Accepted: the verify-and-close work is async; the UI continues to
// poll /status until status=closed.

import { NextResponse } from 'next/server';

import { getCurrentUser } from '@/lib/auth';
import { redis } from '@/lib/redis';
import { sessionKey, setCommand } from '@/lib/session-state';

export const dynamic = 'force-dynamic';

export async function POST(
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

  // Verify ownership: the URL's accountId must match the session's record.
  // Without this, a guessed sessionId on a different account could trigger
  // a save against another admin's session.
  const accountId = await redis.hget(sessionKey(sessionId), 'accountId');
  if (!accountId) {
    return NextResponse.json(
      { error: 'Session not found.', code: 'NOT_FOUND' },
      { status: 404 },
    );
  }
  if (accountId !== params.id) {
    return NextResponse.json(
      { error: 'Session does not belong to this account.', code: 'FORBIDDEN' },
      { status: 403 },
    );
  }

  await setCommand(redis, sessionId, 'save');
  return new NextResponse(null, { status: 202 });
}

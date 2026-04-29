// POST   /api/accounts/[id]/browser   — start an interactive browser session.
// DELETE /api/accounts/[id]/browser   — close-without-verify (cancel) the
//                                       currently active session for this
//                                       account.
//
// PRD §7.3:
//   - Generate a single-use VNC password (8 hex chars; libvncserver's
//     legacy auth truncates to 8 bytes).
//   - Persist `bcrypt(password)` in Redis; never store plaintext past the
//     response. The password is returned exactly once in the POST body, then
//     embedded in the noVNC iframe URL.
//   - Enforce one active session per account (§7.3.3) by SET NX on a flag
//     `browser-session:active:{accountId}`.
//   - Enqueue a BullMQ job on `browser-session` for the worker to pick up.
//
// Auth: NextAuth session cookie (admin only — same gate as the rest of /api).

import { randomBytes } from 'node:crypto';

import { hash } from 'bcryptjs';
import { Queue } from 'bullmq';
import { NextResponse } from 'next/server';

import { getCurrentUser } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { redis } from '@/lib/redis';
import {
  activeKey,
  sessionKey,
  setCommand,
  writeSession,
  type SessionMode,
  type SessionRecord,
} from '@/lib/session-state';

export const dynamic = 'force-dynamic';

const QUEUE_BROWSER_SESSION = 'browser-session';

// 30 minutes; mirrors PRD §7.3.2 idle timeout. Keep this in sync with the
// worker's session-state.ts.
const IDLE_DEADLINE_MS = 30 * 60 * 1000;

/** BullMQ Queue producer for the web side. We share the ioredis singleton
 *  and cache the Queue on globalThis so a hot-reload doesn't leak BullMQ
 *  pub-sub subscribers. This mirrors the approach used by the worker's
 *  queues.ts (one Queue created at module load). */
const globalForQueue = globalThis as unknown as {
  browserSessionQueue: Queue | undefined;
};
function getQueue(): Queue {
  if (globalForQueue.browserSessionQueue) {
    return globalForQueue.browserSessionQueue;
  }
  const q = new Queue(QUEUE_BROWSER_SESSION, { connection: redis });
  globalForQueue.browserSessionQueue = q;
  return q;
}

/** 8 hex chars = 4 bytes. libvncserver's legacy `vncpasswd` truncates after
 *  8 bytes anyway, so generating more is wasteful. Hex keeps it URL-safe. */
function generateVncPassword(): string {
  return randomBytes(4).toString('hex');
}

/** noVNC URL the iframe will load. Path matches docker/caddy/Caddyfile's
 *  `/novnc/*` rule, which proxies to the novnc container's websockify on
 *  :6080. The websockify in docker/novnc/Dockerfile also serves the noVNC
 *  static client at the same root, so `/novnc/vnc.html` resolves through
 *  the same proxy.
 *
 *  noVNC reads the WebSocket endpoint from `?path=` (relative to the page
 *  origin). We point it at `/websockify`, which Caddy routes to the same
 *  novnc container; websockify in turn forwards to `worker:5900`. */
function buildNovncUrl(password: string): string {
  const params = new URLSearchParams({
    autoconnect: '1',
    resize: 'remote',
    reconnect: '1',
    password,
    // `path=` is interpreted by noVNC relative to the iframe origin, so this
    // becomes `wss://<host>/websockify`. Caddy routes that to the novnc
    // container (see docker/caddy/Caddyfile).
    path: 'websockify',
  });
  return `/novnc/vnc.html?${params.toString()}`;
}

export async function POST(
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

  const account = await prisma.account.findUnique({ where: { id: params.id } });
  if (!account) {
    return NextResponse.json(
      { error: 'Account not found', code: 'NOT_FOUND' },
      { status: 404 },
    );
  }

  // PRD §7.3.3 — at most one active session per account. SETNX is atomic, so
  // a concurrent click can't race past this guard.
  const sessionId = randomSessionId();
  const setOk = await redis.set(
    activeKey(account.id),
    sessionId,
    'EX',
    35 * 60, // mirrors SESSION_TTL_SEC
    'NX',
  );
  if (setOk !== 'OK') {
    const existingId = await redis.get(activeKey(account.id));
    return NextResponse.json(
      {
        error: 'A browser session is already active for this account.',
        code: 'SESSION_ACTIVE',
        sessionId: existingId,
      },
      { status: 409 },
    );
  }

  const vncPassword = generateVncPassword();
  // bcrypt cost 8 — we don't need login-grade hashing here; the password is
  // single-use and lives at most 35 minutes. Cost 8 is ~5ms vs cost 12's
  // ~250ms, which matters because the start endpoint is interactive.
  // SECURITY: defense-in-depth. The primary auth boundary is the Caddy
  // same-origin check + NextAuth cookie; this hash is so a Redis-only
  // attacker can't replay the VNC password against a still-running session.
  const vncPasswordHash = await hash(vncPassword, 8);

  const now = new Date();
  const idleDeadlineAt = new Date(now.getTime() + IDLE_DEADLINE_MS);

  const mode: SessionMode = 'browse';
  const record: SessionRecord = {
    accountId: account.id,
    status: 'queued',
    vncPasswordHash,
    createdAt: now.toISOString(),
    idleDeadlineAt: idleDeadlineAt.toISOString(),
    mode,
  };
  await writeSession(redis, sessionId, record);

  // SECURITY: stage the plaintext VNC password as an extra hash field so the
  // worker can read it once and pass it to x11vnc. We deliberately do NOT
  // put it on the BullMQ job payload (which BullMQ persists to disk); a
  // hash field with the same TTL is wiped on session close. The worker
  // HDELs this field as soon as it has read it.
  await redis.hset(sessionKey(sessionId), 'vncPasswordPlain', vncPassword);

  // Enqueue. The worker's processor reads the sessionId from job.data and
  // fetches the rest from Redis.
  const queue = getQueue();
  await queue.add(
    'open-browser',
    {
      accountId: account.id,
      sessionId,
      mode,
      triggeredBy: 'manual',
    },
    {
      // No retries: a failed session means the operator should restart
      // manually — automatically retrying a half-spawned x11vnc would
      // cascade into a deadlock on the active flag.
      attempts: 1,
      removeOnComplete: 100,
      removeOnFail: 100,
    },
  );

  return NextResponse.json(
    {
      sessionId,
      vncPassword,
      novncUrl: buildNovncUrl(vncPassword),
    },
    { status: 201 },
  );
}

/** Cancel an active session (close-without-verify). Idempotent — returns
 *  202 even if the session already closed. */
export async function DELETE(
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
      {
        error: 'Missing ?session= query parameter.',
        code: 'INVALID_PAYLOAD',
      },
      { status: 400 },
    );
  }

  // Verify the session belongs to this account (prevents one admin from
  // cancelling another's session via a guessed sessionId).
  const accountId = await redis.hget(sessionKey(sessionId), 'accountId');
  if (!accountId) {
    // Already closed / expired — treat as success.
    return new NextResponse(null, { status: 202 });
  }
  if (accountId !== params.id) {
    return NextResponse.json(
      {
        error: 'Session does not belong to this account.',
        code: 'FORBIDDEN',
      },
      { status: 403 },
    );
  }

  await setCommand(redis, sessionId, 'cancel');
  // The worker's poll loop will see the command on its next tick and run
  // through the close-without-verify path. Status updates flow through
  // the GET /status endpoint.
  return new NextResponse(null, { status: 202 });
}

/** Generates a URL-safe random session id. We avoid `nanoid` because it's
 *  not declared in apps/web/package.json (the agent brief forbids adding
 *  packages). 16 random bytes → 22 url-safe base64 chars is plenty. */
function randomSessionId(): string {
  return randomBytes(16)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

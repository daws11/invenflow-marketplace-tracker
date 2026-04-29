// Browser-session shared state — keys, TTLs, and small Redis helpers.
//
// The web app (apps/web/src/app/api/accounts/[id]/browser/*) writes the
// initial session record + commands; the worker reads those, drives the
// browser, and writes status updates back. Both sides import from this
// module so the key shapes can never drift apart.
//
// Key shapes (PRD §7.3):
//   browser-session:{sessionId}              hash {accountId, status,
//                                                  vncPasswordHash, createdAt,
//                                                  idleDeadlineAt,
//                                                  chromiumPid?, vncPid?,
//                                                  mode}
//   browser-session:{sessionId}:command      string ('save'|'close'|'cancel')
//   browser-session:active:{accountId}       string sessionId   (active flag)
//
// All keys carry an explicit TTL (35 minutes for the session record, matching
// the 30-minute idle deadline + a 5-minute closing buffer). The worker
// extends the TTL while the session is active and clears the keys on close.

import type { Redis } from 'ioredis';

// -----------------------------------------------------------------------------
// Key shapes
// -----------------------------------------------------------------------------

export const sessionKey = (sessionId: string): string =>
  `browser-session:${sessionId}`;

export const commandKey = (sessionId: string): string =>
  `browser-session:${sessionId}:command`;

export const activeKey = (accountId: string): string =>
  `browser-session:active:${accountId}`;

// -----------------------------------------------------------------------------
// Status state machine — single source of truth for the strings on the wire
// -----------------------------------------------------------------------------

export type SessionStatus =
  | 'queued'    // web enqueued the job, worker hasn't picked it up yet
  | 'starting' // worker is launching x11vnc + Stagehand
  | 'ready'    // browser is up, admin can drive it
  | 'closing'  // command received; worker is verifying / cleaning up
  | 'closed';  // final state — UI should redirect

export type SessionCommand = 'save' | 'close' | 'cancel';

export type SessionMode = 'browse' | 'login' | 'refresh';

export interface SessionRecord {
  accountId: string;
  status: SessionStatus;
  /** bcrypt hash of the single-use VNC password. Worker never sees plaintext. */
  vncPasswordHash: string;
  /** ISO timestamp string. */
  createdAt: string;
  /** ISO timestamp string. Worker bails out if Date.now() >= this. */
  idleDeadlineAt: string;
  mode: SessionMode;
  /** Worker writes these once the browser stack is up. */
  chromiumPid?: string;
  vncPid?: string;
  /** Worker writes a short error string if a step throws. */
  errorMessage?: string;
  /** Worker writes the final status from the lifecycle (closed / verified / not). */
  finalStatus?: string;
}

// -----------------------------------------------------------------------------
// TTLs (seconds)
// -----------------------------------------------------------------------------

/** 35 minutes — 30 min idle + 5 min closing buffer. */
export const SESSION_TTL_SEC = 35 * 60;

/** 60 seconds — keeps the `closed` record around long enough for the UI's
 *  next poll to read it, then drops it. */
export const CLOSED_TTL_SEC = 60;

// -----------------------------------------------------------------------------
// Helpers — typed wrappers over HSET/HGET/etc. The web side uses the same
// helpers so the field-name → JS-property mapping is enforced once.
// -----------------------------------------------------------------------------

export async function writeSession(
  redis: Redis,
  sessionId: string,
  rec: SessionRecord,
): Promise<void> {
  // ioredis accepts an object form for HSET in v5. Strip undefined so we
  // don't store the literal string "undefined".
  const flat: Record<string, string> = {};
  for (const [k, v] of Object.entries(rec)) {
    if (v !== undefined) flat[k] = String(v);
  }
  await redis.hset(sessionKey(sessionId), flat);
  await redis.expire(sessionKey(sessionId), SESSION_TTL_SEC);
}

export async function readSession(
  redis: Redis,
  sessionId: string,
): Promise<SessionRecord | null> {
  const raw = await redis.hgetall(sessionKey(sessionId));
  if (!raw || Object.keys(raw).length === 0) return null;
  // We only assert presence of the truly required fields; everything else
  // is optional in the type.
  if (!raw.accountId || !raw.status || !raw.createdAt || !raw.mode) {
    return null;
  }
  return raw as unknown as SessionRecord;
}

export async function setStatus(
  redis: Redis,
  sessionId: string,
  status: SessionStatus,
): Promise<void> {
  await redis.hset(sessionKey(sessionId), 'status', status);
}

export async function setStatusFields(
  redis: Redis,
  sessionId: string,
  fields: Partial<SessionRecord>,
): Promise<void> {
  const flat: Record<string, string> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v !== undefined) flat[k] = String(v);
  }
  if (Object.keys(flat).length === 0) return;
  await redis.hset(sessionKey(sessionId), flat);
}

export async function getStatus(
  redis: Redis,
  sessionId: string,
): Promise<SessionStatus | null> {
  const v = await redis.hget(sessionKey(sessionId), 'status');
  return (v as SessionStatus | null) ?? null;
}

export async function getCommand(
  redis: Redis,
  sessionId: string,
): Promise<SessionCommand | null> {
  const v = await redis.get(commandKey(sessionId));
  return (v as SessionCommand | null) ?? null;
}

export async function setCommand(
  redis: Redis,
  sessionId: string,
  command: SessionCommand,
): Promise<void> {
  // Match the parent session's TTL so a stale command can't outlive the
  // session record.
  await redis.set(commandKey(sessionId), command, 'EX', SESSION_TTL_SEC);
}

export async function clearActive(
  redis: Redis,
  accountId: string,
  sessionId: string,
): Promise<void> {
  // Only clear if WE own the active flag — don't accidentally release
  // someone else's session if there's a race.
  const current = await redis.get(activeKey(accountId));
  if (current === sessionId) {
    await redis.del(activeKey(accountId));
  }
}

/**
 * Final cleanup: drop the command key, clear the active flag (if it still
 * points at this session), and demote the session record to a short TTL so
 * the UI's last poll can still read `status=closed`.
 */
export async function clearSession(
  redis: Redis,
  sessionId: string,
  accountId: string,
): Promise<void> {
  await redis.del(commandKey(sessionId));
  await clearActive(redis, accountId, sessionId);
  // Mark closed and let the record expire shortly so the UI's last poll
  // can read `status=closed`.
  await setStatus(redis, sessionId, 'closed');
  await redis.expire(sessionKey(sessionId), CLOSED_TTL_SEC);
}

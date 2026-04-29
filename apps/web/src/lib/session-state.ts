// Browser-session shared state — web mirror of
// `apps/worker/src/queue/session-state.ts`.
//
// Sharing decision (C2b): duplicated rather than moved to packages/shared,
// matching the precedent set in C1 for `lib/db.ts`. The constants below
// MUST stay in sync with the worker's copy. If you change a key name,
// status string, or TTL on either side, change it here too.

import type { Redis } from 'ioredis';

export const sessionKey = (sessionId: string): string =>
  `browser-session:${sessionId}`;

export const commandKey = (sessionId: string): string =>
  `browser-session:${sessionId}:command`;

export const activeKey = (accountId: string): string =>
  `browser-session:active:${accountId}`;

export type SessionStatus =
  | 'queued'
  | 'starting'
  | 'ready'
  | 'closing'
  | 'closed';

export type SessionCommand = 'save' | 'close' | 'cancel';

export type SessionMode = 'browse' | 'login' | 'refresh';

export interface SessionRecord {
  accountId: string;
  status: SessionStatus;
  vncPasswordHash: string;
  createdAt: string;
  idleDeadlineAt: string;
  mode: SessionMode;
  chromiumPid?: string;
  vncPid?: string;
  errorMessage?: string;
  finalStatus?: string;
}

export const SESSION_TTL_SEC = 35 * 60;
export const CLOSED_TTL_SEC = 60;

export async function writeSession(
  redis: Redis,
  sessionId: string,
  rec: SessionRecord,
): Promise<void> {
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
  if (!raw.accountId || !raw.status || !raw.createdAt || !raw.mode) {
    return null;
  }
  return raw as unknown as SessionRecord;
}

export async function setCommand(
  redis: Redis,
  sessionId: string,
  command: SessionCommand,
): Promise<void> {
  await redis.set(commandKey(sessionId), command, 'EX', SESSION_TTL_SEC);
}

'use client';

// Interactive browser-session UI (PRD §7.3).
//
// State machine the component runs:
//
//   mount ──POST /api/accounts/[id]/browser─────────────────────────────┐
//      │                                                                 │
//      │   201 OK  → store {sessionId, novncUrl}; begin polling /status  │
//      │   409     → show "session already active" + force-cancel button │
//      │   other   → show error                                          │
//      └────────────────────────────────────────────────────────────────┘
//
//   poll loop (every pollIntervalMs from /status):
//      queued / starting → spinner
//      ready             → render noVNC iframe + control buttons
//      closing           → spinner + "Saving session…"
//      closed            → redirect to /accounts
//
//   buttons:
//      Save Session & Close → POST /browser/save?session=…
//      Close Without Verify → DELETE /browser?session=…
//      Cancel               → DELETE /browser?session=…   (same wire op)
//
// SECURITY: the VNC password is embedded into the iframe URL once. We never
// log it, and once `closed` is observed the URL is no longer renderable
// (component navigates away). Per PRD §12.3, v1's auth model is
// "single-use VNC password + same-origin cookie + private docker network".

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { AccountStatus, Platform } from '@prisma/client';

import { PlatformBadge, StatusBadge } from '../../_account-helpers';

interface AccountSummary {
  id: string;
  name: string;
  platform: Platform;
  status: AccountStatus;
}

type LocalPhase =
  | 'starting-request' // POST in flight
  | 'session-active'   // session exists; poll loop driving UI
  | 'conflict'         // 409 — another session is up for this account
  | 'error';           // unrecoverable client-visible error

interface SessionInfo {
  sessionId: string;
  novncUrl: string;
}

interface StatusResponse {
  status: 'queued' | 'starting' | 'ready' | 'closing' | 'closed';
  idleDeadlineAt: string;
  finalStatus?: string;
  errorMessage?: string;
  pollIntervalMs?: number;
}

const DEFAULT_POLL_MS = 1000;

export function BrowserSessionClient({ account }: { account: AccountSummary }) {
  const router = useRouter();

  const [phase, setPhase] = useState<LocalPhase>('starting-request');
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<
    null | 'save' | 'close' | 'cancel' | 'force-cancel'
  >(null);

  // We start the session exactly once on mount. React 18 strict mode runs
  // effects twice in dev — the StrictMode-tolerant pattern is a ref guard.
  const startedRef = useRef(false);

  // ---------------------------------------------------------------------------
  // 1. Start a session (or detect a 409 conflict).
  // ---------------------------------------------------------------------------
  const startSession = useCallback(async () => {
    setPhase('starting-request');
    setError(null);
    try {
      const res = await fetch(`/api/accounts/${account.id}/browser`, {
        method: 'POST',
      });
      if (res.status === 409) {
        const body = (await res.json().catch(() => ({}))) as {
          sessionId?: string;
        };
        // Stash the existing sessionId so the "Force cancel" button can
        // address the right session.
        setSession(
          body.sessionId
            ? { sessionId: body.sessionId, novncUrl: '' }
            : null,
        );
        setPhase('conflict');
        return;
      }
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(body.error ?? `Failed to start session (${res.status})`);
      }
      const body = (await res.json()) as SessionInfo;
      setSession(body);
      setPhase('session-active');
    } catch (err) {
      setError((err as Error).message);
      setPhase('error');
    }
  }, [account.id]);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    void startSession();
  }, [startSession]);

  // ---------------------------------------------------------------------------
  // 2. Poll /status while a session exists. Also stops on `closed` and
  //    redirects.
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (phase !== 'session-active' || !session) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const poll = async () => {
      try {
        const res = await fetch(
          `/api/accounts/${account.id}/browser/status?session=${encodeURIComponent(session.sessionId)}`,
          { cache: 'no-store' },
        );
        if (!res.ok) {
          if (res.status === 404) {
            // Session expired or was cleaned up out from under us. Treat as
            // closed; redirect.
            if (!cancelled) router.replace('/accounts');
            return;
          }
          throw new Error(`Status poll failed (${res.status})`);
        }
        const body = (await res.json()) as StatusResponse;
        if (cancelled) return;
        setStatus(body);
        if (body.status === 'closed') {
          // Slight delay so the operator sees the "closed" UI tick before we
          // navigate away.
          setTimeout(() => router.replace('/accounts'), 400);
          return;
        }
        timer = setTimeout(poll, body.pollIntervalMs ?? DEFAULT_POLL_MS);
      } catch (err) {
        if (cancelled) return;
        setError((err as Error).message);
        setPhase('error');
      }
    };

    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [account.id, phase, session, router]);

  // ---------------------------------------------------------------------------
  // 3. Action handlers.
  // ---------------------------------------------------------------------------
  const onSave = useCallback(async () => {
    if (!session || pendingAction) return;
    setPendingAction('save');
    try {
      const res = await fetch(
        `/api/accounts/${account.id}/browser/save?session=${encodeURIComponent(session.sessionId)}`,
        { method: 'POST' },
      );
      if (!res.ok && res.status !== 202) {
        throw new Error(`Save failed (${res.status})`);
      }
      // Worker will flip status to `closing`, then `closed`. Poll loop drives
      // the rest.
    } catch (err) {
      setError((err as Error).message);
      setPendingAction(null);
    }
  }, [account.id, session, pendingAction]);

  const onCancel = useCallback(
    async (label: 'close' | 'cancel' = 'cancel') => {
      if (!session || pendingAction) return;
      setPendingAction(label);
      try {
        const res = await fetch(
          `/api/accounts/${account.id}/browser?session=${encodeURIComponent(session.sessionId)}`,
          { method: 'DELETE' },
        );
        if (!res.ok && res.status !== 202) {
          throw new Error(`Close failed (${res.status})`);
        }
      } catch (err) {
        setError((err as Error).message);
        setPendingAction(null);
      }
    },
    [account.id, session, pendingAction],
  );

  const onForceCancel = useCallback(async () => {
    if (!session) {
      // No sessionId came back — nothing we can target. Reload to retry.
      router.refresh();
      return;
    }
    setPendingAction('force-cancel');
    try {
      const res = await fetch(
        `/api/accounts/${account.id}/browser?session=${encodeURIComponent(session.sessionId)}`,
        { method: 'DELETE' },
      );
      if (!res.ok && res.status !== 202) {
        throw new Error(`Force cancel failed (${res.status})`);
      }
      // Wait briefly for the worker to release the active flag, then retry
      // the start.
      setTimeout(() => {
        startedRef.current = false;
        setSession(null);
        setStatus(null);
        setPendingAction(null);
        void startSession();
      }, 1500);
    } catch (err) {
      setError((err as Error).message);
      setPendingAction(null);
    }
  }, [account.id, session, router, startSession]);

  // ---------------------------------------------------------------------------
  // 4. Idle countdown.
  // ---------------------------------------------------------------------------
  const idleCountdown = useIdleCountdown(status?.idleDeadlineAt);

  // ---------------------------------------------------------------------------
  // 5. Render.
  // ---------------------------------------------------------------------------
  return (
    <div className="flex h-[calc(100vh-4rem)] flex-col">
      <header className="flex flex-wrap items-center gap-3 border-b border-neutral-200 bg-white px-6 py-3">
        <h1 className="mr-2 text-base font-semibold text-neutral-900">
          {account.name}
        </h1>
        <PlatformBadge platform={account.platform} />
        <StatusBadge status={account.status} />
        <span className="text-xs text-neutral-500">
          Session: {phaseLabel(phase, status?.status)}
        </span>
        {idleCountdown ? (
          <span className="text-xs text-neutral-500">
            Idle timeout in {idleCountdown}
          </span>
        ) : null}
        <div className="ml-auto flex gap-2">
          {phase === 'session-active' && status?.status === 'ready' ? (
            <>
              <button
                type="button"
                onClick={onSave}
                disabled={!!pendingAction}
                className="inline-flex items-center justify-center rounded-md bg-green-600 px-3 py-1.5 text-xs font-medium text-white shadow-sm transition hover:bg-green-700 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {pendingAction === 'save' ? 'Saving…' : 'Save Session & Close'}
              </button>
              <button
                type="button"
                onClick={() => onCancel('close')}
                disabled={!!pendingAction}
                className="inline-flex items-center justify-center rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-xs font-medium text-neutral-700 shadow-sm transition hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {pendingAction === 'close' ? 'Closing…' : 'Close Without Verification'}
              </button>
              <button
                type="button"
                onClick={() => onCancel('cancel')}
                disabled={!!pendingAction}
                className="inline-flex items-center justify-center rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-xs font-medium text-neutral-700 shadow-sm transition hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {pendingAction === 'cancel' ? 'Cancelling…' : 'Cancel'}
              </button>
            </>
          ) : null}
        </div>
      </header>

      <div className="relative flex-1 bg-neutral-100">
        {phase === 'starting-request' ? (
          <CentreCard>
            <Spinner /> Starting browser session…
          </CentreCard>
        ) : null}

        {phase === 'conflict' ? (
          <CentreCard>
            <p className="text-sm font-medium text-neutral-800">
              A session is already active for this account.
            </p>
            <p className="mt-1 text-xs text-neutral-500">
              You can force-cancel it and start a new one.
            </p>
            <button
              type="button"
              onClick={onForceCancel}
              disabled={!!pendingAction}
              className="mt-4 inline-flex items-center justify-center rounded-md border border-red-300 bg-white px-3 py-1.5 text-xs font-medium text-red-700 shadow-sm transition hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {pendingAction === 'force-cancel'
                ? 'Force-cancelling…'
                : 'Force cancel & retry'}
            </button>
          </CentreCard>
        ) : null}

        {phase === 'error' ? (
          <CentreCard>
            <p className="text-sm font-medium text-red-700">
              {error ?? 'Unknown error.'}
            </p>
            <button
              type="button"
              onClick={() => router.replace('/accounts')}
              className="mt-4 inline-flex items-center justify-center rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-xs font-medium text-neutral-700 shadow-sm transition hover:bg-neutral-50"
            >
              Back to accounts
            </button>
          </CentreCard>
        ) : null}

        {phase === 'session-active' && session ? (
          status?.status === 'ready' ? (
            <iframe
              title={`Browser session for ${account.name}`}
              src={session.novncUrl}
              className="h-full w-full border-0"
              // SECURITY: noVNC needs scripts and same-origin to handshake;
              // the iframe is served from the same Caddy origin so no
              // cross-origin sandbox flag is needed.
              allow="clipboard-read; clipboard-write"
            />
          ) : (
            <CentreCard>
              <Spinner />{' '}
              {status?.status === 'closing'
                ? 'Saving session and closing browser…'
                : 'Browser starting…'}
            </CentreCard>
          )
        ) : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Small helpers — kept inline because they're trivial and only used here.
// ---------------------------------------------------------------------------

function phaseLabel(
  phase: LocalPhase,
  remoteStatus: StatusResponse['status'] | undefined,
): string {
  if (phase === 'starting-request') return 'requesting…';
  if (phase === 'conflict') return 'conflict';
  if (phase === 'error') return 'error';
  return remoteStatus ?? 'starting';
}

function CentreCard({ children }: { children: React.ReactNode }) {
  return (
    <div className="absolute inset-0 flex items-center justify-center">
      <div className="rounded-lg border border-neutral-200 bg-white px-6 py-5 text-center shadow-sm">
        <div className="flex items-center justify-center gap-2 text-sm text-neutral-700">
          {children}
        </div>
      </div>
    </div>
  );
}

function Spinner() {
  return (
    <span
      aria-label="Loading"
      className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-neutral-300 border-t-neutral-700"
    />
  );
}

/** Returns a human-readable countdown like "27m 14s" until idleDeadline,
 *  or null if the deadline is missing/in the past. */
function useIdleCountdown(deadlineIso: string | undefined): string | null {
  const deadlineMs = useMemo(() => {
    if (!deadlineIso) return null;
    const t = Date.parse(deadlineIso);
    return Number.isFinite(t) ? t : null;
  }, [deadlineIso]);

  const [, force] = useState(0);
  useEffect(() => {
    if (!deadlineMs) return;
    const t = setInterval(() => force((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [deadlineMs]);

  if (!deadlineMs) return null;
  const remainMs = deadlineMs - Date.now();
  if (remainMs <= 0) return null;
  const totalSec = Math.floor(remainMs / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}m ${String(s).padStart(2, '0')}s`;
}

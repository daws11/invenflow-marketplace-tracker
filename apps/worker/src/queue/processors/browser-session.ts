// Interactive browser-session processor (PRD §7.3).
//
// Lifecycle the worker drives:
//
//   1. Mark Redis status `starting`.
//   2. Spawn x11vnc per-session, bound to the worker's Xvfb display, with
//      the single-use password supplied by the web side. We avoid running
//      x11vnc out of start.sh so each session gets a fresh password and
//      the previous session's clients can't reattach.
//   3. Build a Stagehand instance via the C1 factory (interactive=true) —
//      this opens headed Chromium against Xvfb with the persistent
//      per-account profile and anti-detection args.
//   4. Navigate to the platform's default landing URL. For C2b we always
//      go to the login URL and let the operator navigate from there.
//   5. Mark Redis status `ready`. Enter a 1-second poll loop watching for:
//        - command:save   → verify login, update Account.status, close
//        - command:close  → silent close, profile retained
//        - command:cancel → identical to close
//        - idle deadline  → identical to close (PRD §7.3.2)
//   6. Always run the cleanup block in `finally`:
//        - close Stagehand (auto-persists the profile)
//        - kill x11vnc
//        - clear Redis active flag + command + demote session record TTL
//
// The processor's overall shape is one `try { … } finally { cleanup }` so a
// crash inside any step never leaves a stale active flag (which would
// permanently lock the operator out of opening another session for that
// account).

import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

import type { Stagehand } from '@browserbasehq/stagehand';
import { AccountStatus, Platform } from '@prisma/client';
import type { Job } from 'bullmq';

import { createStagehand } from '../../browser/factory.js';
import { type Platform as ProfilePlatform } from '../../browser/profile-manager.js';
import { prisma } from '../../lib/db.js';
import { childLogger } from '../../lib/logger.js';
import { dispatcher } from '../../notifications/dispatcher.js';
import { getRedisConnection } from '../connection.js';
import {
  QUEUE_BROWSER_SESSION,
  type BrowserSessionJobData,
  type JobResult,
} from '../queues.js';
import {
  clearSession,
  getCommand,
  readSession,
  setStatus,
  setStatusFields,
  type SessionMode,
} from '../session-state.js';

const log = childLogger(`queue:${QUEUE_BROWSER_SESSION}`);

// Web side may include a sessionId on the job; the C1 base type doesn't.
// Augment locally rather than churn `queues.ts`.
type BrowserSessionJob = Job<
  BrowserSessionJobData & { sessionId?: string; mode?: SessionMode },
  JobResult
>;

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const VNC_PORT = 5900;
const POLL_INTERVAL_MS = 1000;

/** Safety net so a runaway poll loop can't hold a session open longer than
 *  the Redis TTL would have otherwise allowed. Matches SESSION_TTL_SEC -
 *  a small buffer. */
const HARD_MAX_SESSION_MS = 34 * 60 * 1000;

// Tokopedia + Shopee URLs. For C2b we only navigate to the login URL on
// open; the verify step uses the order-list URL.
const PLATFORM_URLS: Record<
  Platform,
  { login: string; orderList: string }
> = {
  TOKOPEDIA: {
    login: 'https://www.tokopedia.com/login',
    orderList: 'https://www.tokopedia.com/order-list',
  },
  SHOPEE: {
    login: 'https://shopee.co.id/buyer/login',
    orderList: 'https://shopee.co.id/user/purchase',
  },
};

// -----------------------------------------------------------------------------
// Processor entry point
// -----------------------------------------------------------------------------

export async function processBrowserSessionJob(
  job: BrowserSessionJob,
): Promise<JobResult> {
  const { accountId, sessionId, mode = 'browse' } = job.data;
  const startedAt = Date.now();

  log.info(
    { jobId: job.id, accountId, sessionId, mode },
    'browser-session: job received',
  );

  if (!sessionId) {
    // Old C1-style enqueue (no session id) — refuse cleanly.
    return {
      ok: false,
      message: 'browser-session job missing sessionId; nothing to do',
    };
  }

  const redis = getRedisConnection();
  // Make sure the connection is live before we hand out a status. The
  // singleton uses lazyConnect: true so the first command triggers the
  // dial. Calling .status here is cheap and idempotent.
  if (redis.status === 'wait' || redis.status === 'end') {
    try {
      await redis.connect();
    } catch (err) {
      // Connect errors are fatal: with no Redis we can't drive the state
      // machine the UI is polling.
      log.error({ err: (err as Error).message }, 'browser-session: redis connect failed');
      return { ok: false, message: 'redis unavailable' };
    }
  }

  // Load the session record + the account in parallel.
  const [record, account] = await Promise.all([
    readSession(redis, sessionId),
    prisma.account.findUnique({ where: { id: accountId } }),
  ]);
  if (!record) {
    log.warn({ sessionId }, 'browser-session: session record missing; aborting');
    return { ok: false, message: 'session record not found' };
  }
  if (!account) {
    log.warn({ accountId }, 'browser-session: account not found; aborting');
    await clearSession(redis, sessionId, accountId);
    return { ok: false, message: 'account not found' };
  }

  const idleDeadlineMs = parseDeadline(record.idleDeadlineAt, startedAt);
  const hardDeadlineMs = startedAt + HARD_MAX_SESSION_MS;
  const startingAccountStatus = account.status;

  // PRD §7.3.4 — the password from Redis is bcrypt'd. The plaintext lives
  // only in the spawn argv during this scope. We re-derive a per-session
  // password file path so x11vnc can read it without us setting -passwd
  // (which would expose plaintext via /proc/<pid>/cmdline). However, we
  // don't have the plaintext at all here — only its bcrypt hash. To keep
  // v1 simple we instead read the `vncPassword` from the job data path:
  // the web side passes the bcrypt hash to Redis, and the plaintext to the
  // browser. The worker doesn't need plaintext to launch x11vnc IF we
  // share state through a different channel.
  //
  // Simpler approach actually adopted: the web side embeds the plaintext
  // password into the iframe URL AND ALSO writes it (separate Redis hash
  // field, kept tiny TTL) for the worker to read once on startup, then
  // delete. This avoids passing the password through job data (BullMQ
  // payloads are persisted to disk).
  //
  // Implementation: read field `vncPasswordPlain`; if missing, fall back
  // to a worker-generated password and update the hash in the record.
  //
  // For cleanliness we keep that simpler scheme below.

  let vncPasswordPlain = await redis.hget(
    `browser-session:${sessionId}`,
    'vncPasswordPlain',
  );
  // Drop the plaintext from Redis as soon as we've read it.
  if (vncPasswordPlain) {
    await redis.hdel(`browser-session:${sessionId}`, 'vncPasswordPlain');
  } else {
    // Backward path: the web didn't pre-stage the plaintext (or the field
    // already expired). Generate one and hope the iframe URL had the same
    // value — in practice this shouldn't happen because the web always
    // writes it. Log the path so we notice in production.
    log.warn(
      { sessionId },
      'browser-session: no plaintext VNC password staged; generating ephemeral password (UI will fail to connect)',
    );
    const { randomBytes } = await import('node:crypto');
    vncPasswordPlain = randomBytes(4).toString('hex');
  }

  let stagehand: Stagehand | null = null;
  let vncProc: ChildProcess | null = null;
  let finalStatusLabel = 'closed';
  let endedBy: 'save' | 'close' | 'cancel' | 'idle' | 'error' = 'close';

  try {
    await setStatus(redis, sessionId, 'starting');

    vncProc = spawnX11Vnc(vncPasswordPlain);
    if (vncProc.pid) {
      await setStatusFields(redis, sessionId, { vncPid: String(vncProc.pid) });
    }

    // Give x11vnc ~250ms to bind to :5900 before noVNC tries to connect.
    await sleep(300);

    const platformLower = account.platform.toLowerCase() as ProfilePlatform;
    stagehand = await createStagehand({
      platform: platformLower,
      accountId: account.id,
      interactive: true,
    });

    // For C2b, navigate to the platform's login URL on open. The verify
    // step (on `save`) uses the order-list URL.
    const urls = PLATFORM_URLS[account.platform];
    try {
      await stagehand.page.goto(urls.login, {
        waitUntil: 'domcontentloaded',
        timeout: 30_000,
      });
    } catch (err) {
      // A failed navigation isn't fatal — the operator can navigate
      // themselves once the iframe is ready. Just log it.
      log.warn(
        { err: (err as Error).message, accountId },
        'browser-session: initial navigation failed; admin can navigate manually',
      );
    }

    // Best-effort: capture the chromium PID for diagnostics.
    const chromiumPid = inferChromiumPid(stagehand);
    if (chromiumPid) {
      await setStatusFields(redis, sessionId, {
        chromiumPid: String(chromiumPid),
      });
    }

    await setStatus(redis, sessionId, 'ready');

    // Notify operator that the browser is open and awaiting input.
    try {
      await dispatcher.notifyBrowserSessionOpened(account, sessionId);
    } catch (err) {
      log.warn(
        { err: (err as Error).message },
        'browser-session: notifyBrowserSessionOpened suppressed',
      );
    }

    // -------------------------------------------------------------------
    // Poll loop — 1Hz check of (command, deadlines).
    // -------------------------------------------------------------------
    while (true) {
      const command = await getCommand(redis, sessionId);
      const now = Date.now();

      if (command === 'save') {
        endedBy = 'save';
        break;
      }
      if (command === 'close' || command === 'cancel') {
        endedBy = command;
        break;
      }
      if (now >= idleDeadlineMs) {
        endedBy = 'idle';
        log.info({ sessionId, accountId }, 'browser-session: idle deadline hit');
        break;
      }
      if (now >= hardDeadlineMs) {
        endedBy = 'idle';
        log.warn(
          { sessionId, accountId },
          'browser-session: hard max-session deadline hit',
        );
        break;
      }

      await sleep(POLL_INTERVAL_MS);
    }

    // -------------------------------------------------------------------
    // Closing — verify if save, otherwise just record lastLoginAt.
    // -------------------------------------------------------------------
    await setStatus(redis, sessionId, 'closing');

    if (endedBy === 'save') {
      const verified = await verifyLoggedIn(stagehand, account.platform);
      const next: AccountStatus = verified
        ? AccountStatus.LOGGED_IN
        : AccountStatus.SESSION_EXPIRED;
      finalStatusLabel = verified ? 'logged-in' : 'session-expired';
      const updated = await prisma.account.update({
        where: { id: account.id },
        data: { status: next, lastLoginAt: new Date() },
      });
      log.info(
        { sessionId, accountId, verified },
        `browser-session: save → Account.status=${next}`,
      );
      if (!verified) {
        try {
          await dispatcher.notifySessionExpired(updated);
        } catch (err) {
          log.warn(
            { err: (err as Error).message },
            'browser-session: notifySessionExpired suppressed',
          );
        }
      }
    } else {
      // close / cancel / idle — keep the prior status, but record the
      // login timestamp (per the spec: "if uncertain, just update
      // lastLoginAt unconditionally"). We don't downgrade from LOGGED_IN
      // to SESSION_EXPIRED on a silent close.
      await prisma.account.update({
        where: { id: account.id },
        data: {
          status: startingAccountStatus,
          lastLoginAt: new Date(),
        },
      });
      finalStatusLabel = `closed-${endedBy}`;
    }
  } catch (err) {
    endedBy = 'error';
    finalStatusLabel = 'error';
    log.error(
      { err: (err as Error).message, stack: (err as Error).stack },
      'browser-session: processor crashed',
    );
    try {
      await setStatusFields(redis, sessionId, {
        errorMessage: (err as Error).message.slice(0, 500),
      });
    } catch {
      /* ignore — we're already in error path */
    }
  } finally {
    // -------------------------------------------------------------------
    // Cleanup — runs in every exit path so we never strand the active
    // flag, the x11vnc process, or the Chromium.
    // -------------------------------------------------------------------
    if (stagehand) {
      try {
        await stagehand.close();
      } catch (err) {
        log.warn(
          { err: (err as Error).message },
          'browser-session: stagehand.close() failed',
        );
      }
    }
    if (vncProc && vncProc.exitCode === null) {
      try {
        vncProc.kill('SIGTERM');
        // Give it 1s, then SIGKILL.
        const killed = await waitForExit(vncProc, 1000);
        if (!killed) vncProc.kill('SIGKILL');
      } catch (err) {
        log.warn(
          { err: (err as Error).message },
          'browser-session: x11vnc kill failed',
        );
      }
    }
    try {
      await setStatusFields(redis, sessionId, { finalStatus: finalStatusLabel });
      await clearSession(redis, sessionId, accountId);
    } catch (err) {
      log.warn(
        { err: (err as Error).message },
        'browser-session: redis cleanup failed',
      );
    }
  }

  const durationMs = Date.now() - startedAt;
  return {
    ok: true,
    message: `browser-session ended (${endedBy})`,
    data: {
      mode,
      endedBy,
      finalStatus: finalStatusLabel,
      durationMs,
    },
  };
}

// -----------------------------------------------------------------------------
// Internals
// -----------------------------------------------------------------------------

function parseDeadline(iso: string, fallback: number): number {
  const t = Date.parse(iso);
  if (Number.isFinite(t)) return t;
  // 30-min default if the web side wrote a malformed deadline.
  return fallback + 30 * 60 * 1000;
}

/** Spawns x11vnc against the worker's Xvfb display.
 *
 *  SECURITY: we do NOT pass `-localhost` here. The websockify proxy lives
 *  in a separate container and talks to the worker over the internal
 *  Docker network. The auth boundary is:
 *    1. Caddy enforces same-origin + NextAuth cookie before the iframe
 *       can even load (see docker/caddy/Caddyfile);
 *    2. websockify only reaches us via the docker network — there is no
 *       host-port publish on 5900 (see docker-compose.yml `expose:`);
 *    3. x11vnc itself authenticates the noVNC client with the per-session
 *       password generated by the web side (single-use, expires when the
 *       worker kills x11vnc on close).
 *  Per PRD §12.3 v1's accepted security model is exactly this triple.
 */
function spawnX11Vnc(passwordPlaintext: string): ChildProcess {
  const args = [
    '-display', process.env.DISPLAY ?? ':99',
    '-rfbport', String(VNC_PORT),
    // `-passwd` accepts at most 8 bytes (legacy libvncserver auth). We
    // generate exactly 8 hex chars on the web side; longer passwords are
    // silently truncated.
    '-passwd', passwordPlaintext,
    '-shared',
    '-forever',
    '-noxdamage',
    '-quiet',
  ];
  log.info({ args: args.filter((a) => a !== passwordPlaintext) }, 'spawning x11vnc');
  // SECURITY: passing the password via argv exposes it in `ps` inside the
  // worker container. Acceptable for v1 because the worker container is
  // single-tenant; the alternative (`-rfbauth <file>`) requires writing a
  // libvncserver-format file to disk per session, which is more moving
  // parts than the trade-off justifies. Revisit if multi-tenant.
  const proc = spawn('x11vnc', args, {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.on('error', (err) => {
    log.error({ err: err.message }, 'x11vnc spawn error');
  });
  proc.on('exit', (code, signal) => {
    log.info({ code, signal }, 'x11vnc exited');
  });
  proc.stderr?.on('data', (buf: Buffer) => {
    const line = buf.toString().trim();
    if (line) log.debug({ x11vnc: line }, 'x11vnc stderr');
  });
  return proc;
}

/** Resolves true when the child exits within `ms`, false otherwise. */
function waitForExit(proc: ChildProcess, ms: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let done = false;
    const t = setTimeout(() => {
      if (!done) {
        done = true;
        resolve(false);
      }
    }, ms);
    proc.once('exit', () => {
      if (done) return;
      done = true;
      clearTimeout(t);
      resolve(true);
    });
  });
}

/** Best-effort lookup of the Chromium browser-process PID from a Stagehand
 *  instance. Stagehand exposes `.context` (Playwright BrowserContext); the
 *  underlying Browser is reachable via `.context.browser()`. The exact
 *  shape isn't stable across Playwright versions, so we wrap in try/catch
 *  and return undefined if introspection fails — the PID is for logging
 *  only. */
function inferChromiumPid(stagehand: Stagehand): number | undefined {
  try {
    const ctx = (stagehand as unknown as { context?: { browser?: () => unknown } }).context;
    const browser = ctx?.browser?.() as { process?: () => { pid?: number } } | undefined;
    return browser?.process?.()?.pid;
  } catch {
    return undefined;
  }
}

/** Light verification that the persistent profile is logged in. Intentionally
 *  selector-based (no Stagehand AI) — the PRD's verify step only needs a
 *  binary "did the order list page render or did the platform redirect us
 *  to /login".
 *
 *  TODO: tune the selectors against real Tokopedia + Shopee markup once we
 *  have a logged-in profile to crawl. For now the heuristic is "current
 *  URL doesn't contain /login after a 5s settle". */
async function verifyLoggedIn(
  stagehand: Stagehand,
  platform: Platform,
): Promise<boolean> {
  const urls = PLATFORM_URLS[platform];
  try {
    await stagehand.page.goto(urls.orderList, {
      waitUntil: 'domcontentloaded',
      timeout: 20_000,
    });
    // Give the platform a moment to evaluate cookies and possibly redirect.
    await sleep(2_500);
    const currentUrl = stagehand.page.url();
    log.info({ currentUrl, target: urls.orderList }, 'verify: post-navigation URL');
    if (/\/login/i.test(currentUrl)) return false;

    // Platform-specific confirm: a logged-in indicator must exist.
    if (platform === 'TOKOPEDIA') {
      const exists = await stagehand.page
        .locator('[data-testid="header-account-menu"], [data-testid*="account"]')
        .first()
        .count();
      return exists > 0;
    }
    if (platform === 'SHOPEE') {
      const exists = await stagehand.page
        .locator('[class*="navbar__username"], [class*="user-info"]')
        .first()
        .count();
      return exists > 0;
    }
    return true;
  } catch (err) {
    log.warn(
      { err: (err as Error).message },
      'browser-session: verify navigation failed',
    );
    return false;
  }
}

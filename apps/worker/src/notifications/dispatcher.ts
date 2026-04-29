// Notification dispatcher (PRD §7.7 — Notifications via Fonnte).
//
// One method per event:
//   - notifyBrowserSessionOpened(account, sessionId)
//   - notifySessionExpired(account)
//   - notifyRunStarted(run, account)
//   - notifyRunSucceeded(run, account)
//   - notifyRunFailed(run, account, errorMessage)
//   - notifyDailyDigest(summary)
//
// Each method:
//   1. Reads the per-event toggle from Settings; if false, returns silently.
//   2. Builds the message per the PRD §7.7 template (literal strings, with
//      `{appUrl}`, `{platform}`, `{N}`, `{error}` substituted).
//   3. Loads the current Fonnte client (credentials are read each call so an
//      admin editing settings sees them apply on the very next message).
//   4. Calls `client.sendMessage()`.
//   5. Logs the outcome.
//
// Wrapping at every call site is the caller's responsibility — but as belt &
// braces, every method here also try/catches around the actual axios call so
// a Fonnte 5xx never throws past us into a scrape pipeline.

import type { Account, Run } from '@prisma/client';

import { getFonnteClient } from '../lib/fonnte.js';
import { childLogger } from '../lib/logger.js';
import { SETTING_KEYS, getSetting } from '../lib/settings.js';
import type { DailyDigestSummary } from '../queue/processors/daily-digest.js';

const log = childLogger('notifications');

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/** Fetches the configured app URL or a "(app url not set)" fallback. The
 *  fallback is intentionally noisy in the message so the operator notices
 *  and configures it. */
async function getAppUrl(): Promise<string> {
  const url = await getSetting<string>(SETTING_KEYS.appUrl);
  return url && url.trim().length > 0 ? url.replace(/\/+$/, '') : '(app url not set)';
}

function platformLabel(platform: Account['platform']): string {
  return platform === 'TOKOPEDIA' ? 'Tokopedia' : 'Shopee';
}

function passLabel(pass: Run['pass']): string {
  // Match the wire vocabulary the operator already sees in the UI.
  switch (pass) {
    case 'PAID':
      return 'paid';
    case 'SHIPPED':
      return 'shipped';
    case 'LOGIN':
      return 'login';
  }
}

async function shouldNotify(key: string): Promise<boolean> {
  const v = await getSetting<boolean>(key);
  return v === true;
}

async function send(message: string, label: string): Promise<void> {
  try {
    const client = await getFonnteClient();
    await client.sendMessage(message);
    log.info({ label }, 'notification sent');
  } catch (err) {
    // Per the brief: a Fonnte failure must never break the actual run.
    log.warn(
      { label, err: (err as Error).message },
      'notification failed (suppressed)',
    );
  }
}

// -----------------------------------------------------------------------------
// Dispatcher
// -----------------------------------------------------------------------------

export class NotificationDispatcher {
  /**
   * Browser session opened (PRD §7.7 row 1 — "login required" toggle).
   * Template: "Browser session for {platform} opened: {APP_URL}/accounts/{id}/browser"
   */
  async notifyBrowserSessionOpened(
    account: Account,
    _sessionId: string,
  ): Promise<void> {
    if (!(await shouldNotify(SETTING_KEYS.notifyOnLoginRequired))) return;
    const appUrl = await getAppUrl();
    const message = `Browser session for ${platformLabel(account.platform)} opened: ${appUrl}/accounts/${account.id}/browser`;
    await send(message, 'browser-session-opened');
  }

  /**
   * Session expired (PRD §7.7 row 2 — "session expired" toggle).
   * Template: "Session for {platform} expired. Please re-login: {APP_URL}/accounts"
   */
  async notifySessionExpired(account: Account): Promise<void> {
    if (!(await shouldNotify(SETTING_KEYS.notifyOnSessionExpired))) return;
    const appUrl = await getAppUrl();
    const message = `Session for ${platformLabel(account.platform)} expired. Please re-login: ${appUrl}/accounts`;
    await send(message, 'session-expired');
  }

  /**
   * Run started (PRD §7.7 — "run start" toggle, default off).
   * The PRD doesn't supply a literal template for this event because
   * default-off events are noisy by design; we use a concise mirror of the
   * "run success" template shape.
   */
  async notifyRunStarted(run: Run, account: Account): Promise<void> {
    if (!(await shouldNotify(SETTING_KEYS.notifyOnRunStart))) return;
    const appUrl = await getAppUrl();
    const message = `${platformLabel(account.platform)} ${passLabel(run.pass)} run started. ${appUrl}/runs/${run.id}`;
    await send(message, 'run-started');
  }

  /**
   * Run success (PRD §7.7 row 3).
   * Template: "{platform} {pass} run complete. {N} new orders. {APP_URL}/runs/{id}"
   *
   * For shipped-pass runs the "new orders" reading is reinterpreted as the
   * transition count, since shipped passes don't ingest new orders. The
   * template wording is preserved literally (PRD: "use these literal
   * strings"); only the substituted N changes by pass.
   */
  async notifyRunSucceeded(run: Run, account: Account): Promise<void> {
    if (!(await shouldNotify(SETTING_KEYS.notifyOnRunSuccess))) return;
    const appUrl = await getAppUrl();
    const n = run.pass === 'SHIPPED' ? run.transitionCount : run.newOrderCount;
    const message = `${platformLabel(account.platform)} ${passLabel(run.pass)} run complete. ${n} new orders. ${appUrl}/runs/${run.id}`;
    await send(message, 'run-succeeded');
  }

  /**
   * Run failed (PRD §7.7 row 4).
   * Template: "{platform} {pass} run failed: {error}. {APP_URL}/runs/{id}"
   */
  async notifyRunFailed(
    run: Run,
    account: Account,
    errorMessage: string,
  ): Promise<void> {
    if (!(await shouldNotify(SETTING_KEYS.notifyOnRunFail))) return;
    const appUrl = await getAppUrl();
    const message = `${platformLabel(account.platform)} ${passLabel(run.pass)} run failed: ${errorMessage}. ${appUrl}/runs/${run.id}`;
    await send(message, 'run-failed');
  }

  /**
   * Daily digest (PRD §7.7 row 6 — new toggle `notify.dailyDigest`, default on).
   * Template: "Today: {ingested} ingested, {shipped} shipped, {operatorMoved} respected (operator moved), {failed} failed."
   *
   * Appends up to 3 sample operator-moved cases for context.
   */
  async notifyDailyDigest(summary: DailyDigestSummary): Promise<void> {
    // Default ON: only suppress if the toggle is explicitly false.
    const v = await getSetting<boolean>(SETTING_KEYS.notifyOnDailyDigest);
    if (v === false) return;

    const baseLine = `Today: ${summary.ingested} ingested, ${summary.shipped} shipped, ${summary.operatorMoved} respected (operator moved), ${summary.failed} failed.`;

    let message = baseLine;
    if (summary.operatorMovedSamples.length > 0) {
      const lines = summary.operatorMovedSamples
        .map(
          (s, i) =>
            `${i + 1}. ${s.accountName} ${s.invoiceNumber} (${s.lineItemId})`,
        )
        .join('\n');
      message = `${baseLine}\n\nOperator-moved cases:\n${lines}`;
    }

    await send(message, 'daily-digest');
  }
}

// Process-wide singleton — the dispatcher is stateless and just needs one
// instance to bind methods against.
export const dispatcher = new NotificationDispatcher();

// Fonnte WhatsApp client (worker-side mirror of apps/web/src/lib/fonnte.ts).
//
// Sharing decision (C5): Option B — duplicated. The web copy stays canonical;
// if its public surface changes, mirror the change here. The shape is
// identical except for the relative import path of `settings.ts`.
//
// Implementation notes:
//   - axios POST to https://api.fonnte.com/send with x-www-form-urlencoded
//     body and `Authorization: <token>` header.
//   - Graceful no-config fallback (warn + return) so notification call-sites
//     don't have to special-case missing config.
//   - The factory `getFonnteClient()` reads credentials from the Settings
//     table (decrypting the token) so the admin can change them at runtime
//     via the web Settings UI.

import axios, { AxiosError } from 'axios';

import { childLogger } from './logger.js';
import { SETTING_KEYS, getSetting } from './settings.js';

const FONNTE_ENDPOINT = 'https://api.fonnte.com/send';
const log = childLogger('fonnte');

export interface FonnteClientOptions {
  /** API token from https://md.fonnte.com (sent as `Authorization` header). */
  token?: string | null;
  /** Default WhatsApp number to deliver to, e.g. `628xxxxxxxxxx`. */
  target?: string | null;
}

export class FonnteClient {
  private readonly token?: string;
  private readonly target?: string;

  constructor(opts: FonnteClientOptions = {}) {
    this.token = opts.token ?? undefined;
    this.target = opts.target ?? undefined;

    if (!this.token || !this.target) {
      log.warn(
        'Fonnte credentials are not configured. WhatsApp notifications will be skipped.',
      );
    }
  }

  /**
   * Sends a single message. Falls back to a no-op (warning only) when the
   * client wasn't configured — same contract as InvenFlow's helper, so
   * notification call-sites don't have to special-case missing config.
   */
  async sendMessage(message: string, target?: string): Promise<void> {
    const trimmed = message?.trim();
    if (!trimmed) return;

    const effectiveTarget = target ?? this.target;
    if (!this.token || !effectiveTarget) {
      log.warn('Skipping send — token or target missing.');
      return;
    }

    const formBody = new URLSearchParams({
      target: effectiveTarget,
      message: trimmed,
    });

    try {
      const response = await axios.post(FONNTE_ENDPOINT, formBody.toString(), {
        headers: {
          Authorization: this.token,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      });
      log.info(
        { status: response.status, statusText: response.statusText },
        'Fonnte message sent',
      );
    } catch (error) {
      const err = error as AxiosError;
      const responsePayload =
        err.response?.data && typeof err.response.data === 'object'
          ? JSON.stringify(err.response.data)
          : (err.response?.data ?? err.message);
      log.error(
        { err: responsePayload },
        'Failed to send WhatsApp notification',
      );
      throw err;
    }
  }
}

/**
 * Loads the current Fonnte credentials from the Settings table (decrypting
 * the token) and constructs a `FonnteClient`. Returns a client even when
 * config is missing — its `sendMessage` will then warn-and-return.
 */
export async function getFonnteClient(): Promise<FonnteClient> {
  const [token, target] = await Promise.all([
    getSetting<string>(SETTING_KEYS.fonnteToken),
    getSetting<string>(SETTING_KEYS.fonnteTarget),
  ]);
  return new FonnteClient({ token, target });
}

/** Convenience helper — loads credentials lazily on each call so an admin
 *  editing settings sees them apply on the very next message. */
export async function sendFonnteMessage(
  message: string,
  target?: string,
): Promise<void> {
  if (!message || message.trim().length === 0) return;
  const client = await getFonnteClient();
  await client.sendMessage(message.trim(), target);
}

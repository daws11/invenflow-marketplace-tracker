// Fonnte WhatsApp client (sidecar version).
//
// Mirrors the structure of `invenflow/packages/backend/src/services/fonnte-client.ts`:
//   - class with constructor that captures `token` and `target`
//   - graceful no-config fallback (warn + return)
//   - single async `sendMessage` method
//   - axios POST to https://api.fonnte.com/send with x-www-form-urlencoded
//     body and `Authorization: <token>` header
//
// Difference: the sidecar reads credentials from the Settings table (so the
// admin can change them at runtime via the Settings UI) rather than directly
// from `process.env`. Use the `getFonnteClient()` factory to construct a
// client with the current persisted values; pass them to the constructor
// directly when you need explicit overrides (e.g. the "Send Test" button
// using user-supplied form values).

import axios, { AxiosError } from 'axios';

import { SETTING_KEYS, getSetting } from '@/lib/settings';

const FONNTE_ENDPOINT = 'https://api.fonnte.com/send';

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
      console.warn(
        '[Fonnte] Credentials are not configured. WhatsApp notifications will be skipped.',
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
      console.warn(
        '[Fonnte] Skipping send — token or target missing.',
      );
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
      console.log(
        '[Fonnte] Message sent. Status:',
        response.status,
        response.statusText,
        'Body:',
        response.data,
      );
    } catch (error) {
      const err = error as AxiosError;
      const responsePayload =
        err.response?.data && typeof err.response.data === 'object'
          ? JSON.stringify(err.response.data)
          : (err.response?.data ?? err.message);
      console.error(
        '[Fonnte] Failed to send WhatsApp notification:',
        responsePayload,
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

/**
 * Convenience helper mirroring the InvenFlow side's `sendFonnteMessage`
 * top-level function. Loads credentials lazily on each call so an admin
 * editing settings sees them apply on the very next message.
 */
export async function sendFonnteMessage(
  message: string,
  target?: string,
): Promise<void> {
  if (!message || message.trim().length === 0) return;
  const client = await getFonnteClient();
  await client.sendMessage(message.trim(), target);
}

// Browser-profile directory management.
//
// One on-disk profile dir per (platform, accountId) pair. Mounted in the
// container at /data/profiles per docker-compose.yml; a relative
// ./data/profiles fallback lets `pnpm dev` work outside Docker without
// requiring root.
//
// Naming: `<platform>-<accountId>`. accountId is a cuid, so we don't need
// to escape, but we still strip path separators defensively.

import { mkdir, rm, stat } from 'node:fs/promises';
import { resolve, join, isAbsolute } from 'node:path';

import { childLogger } from '../lib/logger.js';

const log = childLogger('browser:profile');

export type Platform = 'tokopedia' | 'shopee';

/**
 * Computes the absolute path of a per-account profile dir without
 * creating it. Honors `PROFILE_ROOT`; falls back to `/data/profiles`
 * (Docker bind-mount) or `<cwd>/data/profiles` outside Docker.
 *
 * The cwd-relative fallback only kicks in if `/data/profiles` is not
 * writable AND `PROFILE_ROOT` is unset; we resolve that lazily inside
 * `ensureProfileDir()` rather than at module load.
 */
export function getProfileDir(platform: Platform, accountId: string): string {
  const safeId = sanitize(accountId);
  const root = resolveProfileRoot();
  return join(root, `${platform}-${safeId}`);
}

/**
 * Creates the profile dir (and any missing parents) with mode 0700, then
 * returns the absolute path. Idempotent.
 */
export async function ensureProfileDir(
  platform: Platform,
  accountId: string,
): Promise<string> {
  const root = await resolveWritableRoot();
  const safeId = sanitize(accountId);
  const dir = join(root, `${platform}-${safeId}`);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  log.debug({ dir, platform, accountId }, 'profile dir ensured');
  return dir;
}

/**
 * Removes the profile dir and all its contents. Used by the Account
 * delete flow (workstream A4). No-op if the dir does not exist.
 */
export async function deleteProfileDir(
  platform: Platform,
  accountId: string,
): Promise<void> {
  const dir = getProfileDir(platform, accountId);
  await rm(dir, { recursive: true, force: true });
  log.info({ dir, platform, accountId }, 'profile dir deleted');
}

// -----------------------------------------------------------------------------
// Internals
// -----------------------------------------------------------------------------

function sanitize(id: string): string {
  // accountId comes from Prisma cuid()/uuid(); whitelist rather than blacklist.
  if (!/^[A-Za-z0-9_-]+$/.test(id)) {
    throw new Error(
      `accountId contains illegal characters for a profile dir: ${JSON.stringify(id)}`,
    );
  }
  return id;
}

/** Cheap synchronous resolver — used by `getProfileDir()`. */
function resolveProfileRoot(): string {
  const fromEnv = process.env.PROFILE_ROOT;
  if (fromEnv && fromEnv.length > 0) {
    return isAbsolute(fromEnv) ? fromEnv : resolve(process.cwd(), fromEnv);
  }
  return '/data/profiles';
}

/**
 * Async variant: tries the configured root first, falls back to a
 * cwd-relative `./data/profiles` if `/data/profiles` is unwritable
 * (typical when running outside Docker). The chosen root is logged once
 * per call — cheap, and `ensureProfileDir()` is on a slow path anyway.
 */
async function resolveWritableRoot(): Promise<string> {
  const primary = resolveProfileRoot();
  try {
    await mkdir(primary, { recursive: true, mode: 0o700 });
    return primary;
  } catch (err) {
    if (process.env.PROFILE_ROOT) {
      // If the operator set PROFILE_ROOT explicitly, surface the error
      // rather than silently falling back to cwd.
      throw err;
    }
    const fallback = resolve(process.cwd(), 'data', 'profiles');
    await mkdir(fallback, { recursive: true, mode: 0o700 });
    log.warn(
      { primary, fallback, err: (err as Error).message },
      'PROFILE_ROOT unwritable; using cwd-relative fallback',
    );
    return fallback;
  }
}

// Re-exported for tests / introspection.
export const __testing = { sanitize, resolveProfileRoot };

// Touch `stat` so the import doesn't get tree-shaken in prod builds; the
// helper is reserved for future use (verify mode bits on existing dirs).
void stat;

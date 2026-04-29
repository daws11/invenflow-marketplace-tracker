// Zod-validated worker environment variables.
//
// Validated once at startup (see ../index.ts). If any required var is
// missing/malformed we throw with a clear message and exit before opening
// network connections — better than a deep ECONNREFUSED stack trace.

import { z } from 'zod';

const EnvSchema = z.object({
  /** Postgres connection string for the sidecar database. */
  DATABASE_URL: z
    .string()
    .min(1, 'DATABASE_URL is required (Postgres connection string).'),

  /** Redis connection string for BullMQ. */
  REDIS_URL: z
    .string()
    .min(1, 'REDIS_URL is required (e.g. redis://localhost:6379).'),

  /**
   * 32-byte AES-256 key, base64-encoded. Generate with
   *   openssl rand -base64 32
   * Validated for length here; encryption.ts enforces the byte-decode size.
   */
  ENCRYPTION_KEY: z
    .string()
    .min(
      1,
      'ENCRYPTION_KEY is required (32 random bytes, base64-encoded — `openssl rand -base64 32`).',
    ),

  /**
   * X11 display the headed Chromium will attach to. Defaults to :99 to
   * match start.sh / docker-compose.yml. Outside Docker (`pnpm dev`) the
   * worker still consults this; Stagehand only uses it when actually
   * launching a browser, which C1's stub processors don't do.
   */
  DISPLAY: z.string().default(':99'),

  /** Standard NODE_ENV — informs logger formatting + Prisma log levels. */
  NODE_ENV: z
    .enum(['development', 'production', 'test'])
    .default('development'),
});

export type WorkerEnv = z.infer<typeof EnvSchema>;

/**
 * Parses `process.env` once and either returns the typed object or throws
 * a single combined error listing every problem. Call exactly once at
 * startup; cache the result.
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): WorkerEnv {
  const result = EnvSchema.safeParse(source);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid worker environment:\n${issues}`);
  }
  return result.data;
}

// Cached singleton. Importers get a typed handle without re-parsing.
let cached: WorkerEnv | null = null;
export const env: WorkerEnv = new Proxy({} as WorkerEnv, {
  get(_target, prop: string) {
    if (!cached) cached = loadEnv();
    return cached[prop as keyof WorkerEnv];
  },
});

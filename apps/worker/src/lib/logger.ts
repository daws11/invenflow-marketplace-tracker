// Pino root logger.
//
// Outputs:
//   * production: JSON lines on stdout (consumed by Docker / log shipper).
//   * dev:        human-readable lines via pino-pretty IF available; falls
//                 back to JSON otherwise. We don't make pino-pretty a hard
//                 dep so worker boot stays a single-package install.
//
// Helper: `childLogger('queue:browser-session')` produces a logger with a
// `component` field stamped on every line.

import pino, { type Logger } from 'pino';

function makeRoot(): Logger {
  const isProd = process.env.NODE_ENV === 'production';

  if (isProd) {
    return pino({
      level: process.env.LOG_LEVEL ?? 'info',
      base: { service: 'worker' },
    });
  }

  // Dev: best-effort pretty transport. If pino-pretty isn't installed,
  // pino throws synchronously on first log; we detect that by trying to
  // require it.
  let prettyAvailable = false;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require.resolve('pino-pretty');
    prettyAvailable = true;
  } catch {
    prettyAvailable = false;
  }

  if (prettyAvailable) {
    return pino({
      level: process.env.LOG_LEVEL ?? 'debug',
      base: { service: 'worker' },
      transport: {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:HH:MM:ss.l',
          ignore: 'pid,hostname,service',
        },
      },
    });
  }

  return pino({
    level: process.env.LOG_LEVEL ?? 'debug',
    base: { service: 'worker' },
  });
}

export const logger: Logger = makeRoot();

/** Returns a child logger tagged with the given component name. */
export const childLogger = (component: string): Logger =>
  logger.child({ component });

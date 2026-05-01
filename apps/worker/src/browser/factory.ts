// Stagehand factory.
//
// Centralizes everything anti-detection (PRD §13) + AI-config-from-DB
// (PRD §11) so per-platform agents (later workstreams) can just call
// `createStagehand({ platform, accountId })` and get a fully wired,
// already-init'd Stagehand instance.
//
// Stagehand version pinned by apps/worker/package.json: 1.14.0. The
// constructor at this version (see node_modules/@browserbasehq/stagehand/
// dist/index.d.ts) accepts:
//   - env: 'LOCAL' | 'BROWSERBASE'
//   - modelName / modelClientOptions   (PRD §11 — sourced from DB)
//   - localBrowserLaunchOptions: {
//       args, userDataDir, viewport, locale, timezoneId, headless, ...
//     }
// We pass the userDataDir, anti-detection chromium args, and locale/
// timezone/viewport through `localBrowserLaunchOptions`. The headless
// toggle lives there too: in-container we always run headed (Xvfb), so
// `headless: false` regardless of `interactive`.
//
// Stealth caveat (PRD §13): Stagehand 1.14 owns the Playwright launch
// internally and exposes only the option bag above — no hook to install
// puppeteer-extra-plugin-stealth into the launched context. That means
// we apply only the args we can pass through (--disable-blink-features=
// AutomationControlled etc.) and TODO the full stealth-plugin wiring for
// when Stagehand exposes a "bring your own context" path, or we fork to
// a thin wrapper that owns the launch ourselves.

import { Stagehand, type AvailableModel } from '@browserbasehq/stagehand';

import { buildStagehandConfig } from '../lib/ai-config.js';
import { childLogger } from '../lib/logger.js';
import { SETTING_KEYS, getSettings } from '../lib/settings.js';
import { ensureProfileDir, type Platform } from './profile-manager.js';

interface ProxyConfig {
  server: string;
  username?: string;
  password?: string;
}

/**
 * Loads proxy config from the Setting table and shapes it for Playwright.
 * Returns `null` when proxy is disabled or the server URL is missing.
 *
 * Indonesian residential / mobile proxies are the canonical fix for
 * Tokopedia / Shopee blocking the VPS's EU datacenter IP — see the
 * "Proxy" tab in Settings.
 */
async function loadProxyConfig(): Promise<ProxyConfig | null> {
  const map = await getSettings([
    SETTING_KEYS.proxyEnabled,
    SETTING_KEYS.proxyServer,
    SETTING_KEYS.proxyUsername,
    SETTING_KEYS.proxyPassword,
  ]);
  const enabled = map.get(SETTING_KEYS.proxyEnabled);
  const server = map.get(SETTING_KEYS.proxyServer);
  if (!enabled || typeof server !== 'string' || server.length === 0) {
    return null;
  }
  const username = map.get(SETTING_KEYS.proxyUsername);
  const password = map.get(SETTING_KEYS.proxyPassword);
  const cfg: ProxyConfig = { server };
  if (typeof username === 'string' && username.length > 0) {
    cfg.username = username;
  }
  if (typeof password === 'string' && password.length > 0) {
    cfg.password = password;
  }
  return cfg;
}

const log = childLogger('browser:factory');

export interface CreateBrowserOptions {
  platform: Platform;
  accountId: string;
  /**
   * If true, the session is interactive (operator drives via VNC). If
   * false, the worker drives the page itself. Both run headed under
   * Xvfb so detection is identical; the flag only changes downstream
   * Stagehand behavior re: human-in-the-loop prompts.
   */
  interactive?: boolean;
}

/**
 * Anti-detection chromium args (PRD §13). Order matters for some
 * Chromium versions — keep `--disable-blink-features` first so
 * AutomationControlled actually gets stripped from `navigator.webdriver`.
 */
const ANTI_DETECTION_ARGS: ReadonlyArray<string> = [
  '--disable-blink-features=AutomationControlled',
  '--no-sandbox',
  '--disable-dev-shm-usage',
  '--lang=id-ID',
];

/**
 * Builds a Stagehand instance for a given (platform, accountId) and calls
 * `.init()` on it before returning. Caller is responsible for
 * `await stagehand.close()` when done.
 */
export async function createStagehand(
  opts: CreateBrowserOptions,
): Promise<Stagehand> {
  const { platform, accountId, interactive = false } = opts;

  const userDataDir = await ensureProfileDir(platform, accountId);
  const aiConfig = await buildStagehandConfig();
  const proxy = await loadProxyConfig();

  log.info(
    {
      platform,
      accountId,
      interactive,
      userDataDir,
      provider: aiConfig.provider,
      modelName: aiConfig.modelName,
      proxy: proxy ? { server: proxy.server, hasAuth: Boolean(proxy.username) } : null,
    },
    'creating stagehand',
  );

  // Stagehand 1.14's `modelName` is typed as the AvailableModelSchema enum.
  // The runtime, however, accepts any string and forwards it to the
  // underlying provider client. PRD §11 is explicit that model strings come
  // from the DB at runtime — we cannot type-narrow against a hardcoded
  // enum here without violating that. Cast to AvailableModel to satisfy
  // the constructor; the provider is the one that will reject an unknown
  // model name with a clean error.
  const modelName = aiConfig.modelName as AvailableModel;

  const stagehand = new Stagehand({
    env: 'LOCAL',
    modelName,
    modelClientOptions: aiConfig.modelClientOptions,
    // Stagehand internally instantiates a logger; we wire it to ours so
    // its categorized logs show up in the worker stream.
    logger: (line) => {
      const msg = line.message ?? '';
      if (line.level === 0) log.error({ category: line.category }, msg);
      else if (line.level === 1) log.info({ category: line.category }, msg);
      else log.debug({ category: line.category }, msg);
    },
    localBrowserLaunchOptions: {
      args: [...ANTI_DETECTION_ARGS],
      headless: false,
      userDataDir,
      viewport: { width: 1920, height: 1080 },
      locale: 'id-ID',
      timezoneId: 'Asia/Jakarta',
      // Inherit DISPLAY from the worker process (set in start.sh / env).
      // Stagehand's `env` field merges into the spawned Chromium's env.
      env: process.env.DISPLAY
        ? { DISPLAY: process.env.DISPLAY }
        : undefined,
      // Forward proxy when configured. Playwright honors this via the
      // `--proxy-server=<server>` chromium arg + an internal username/
      // password injector — every request the headed Chromium makes
      // (page loads, XHR, WebSocket) routes through the proxy.
      ...(proxy ? { proxy } : {}),
    },
    // `interactive` currently informs only logging; once Stagehand
    // exposes a "wait for human" hook, route it here.
    verbose: interactive ? 2 : 1,
  });

  await stagehand.init();

  log.info({ platform, accountId }, 'stagehand initialized');
  return stagehand;
}

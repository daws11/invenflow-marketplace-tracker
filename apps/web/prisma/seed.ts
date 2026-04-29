// Initial admin + initial settings seed (PRD §15.1 step 4–6).
//
// Runs at first boot from `prisma db seed` (configured in package.json under
// "prisma.seed"). Idempotent — every step skips if the underlying record is
// already present, so re-runs are safe (and expected: docker-compose may
// re-execute the seed on container restart).
//
// What we seed (only on the *first* run, from env vars; PRD §14):
//   1. Admin user from INITIAL_ADMIN_EMAIL / INITIAL_ADMIN_PASSWORD
//      (existing behavior).
//   2. Active AiSettings row from INITIAL_AI_PROVIDER / _MODEL / _API_KEY,
//      with the API key encrypted at rest.
//   3. Settings rows from INVENFLOW_BASE_URL, INVENFLOW_INITIAL_SERVICE_TOKEN
//      (secret), ADMIN_WA_NUMBER, FONNTE_TOKEN (secret), APP_URL.

import { hash } from 'bcryptjs';
import { PrismaClient } from '@prisma/client';

import { encrypt } from '../src/lib/encryption';

const BCRYPT_COST = 12;

// Keep these in sync with `src/lib/settings.ts` SETTING_KEYS. Duplicated here
// (rather than imported) so the seed script stays runnable without the Next.js
// path-alias resolver.
const KEY_APP_URL = 'app.url';
const KEY_INVENFLOW_BASE_URL = 'invenflow.baseUrl';
const KEY_INVENFLOW_SERVICE_TOKEN = 'invenflow.serviceToken';
const KEY_FONNTE_TOKEN = 'fonnte.token';
const KEY_FONNTE_TARGET = 'fonnte.target';

async function seedAdmin(prisma: PrismaClient): Promise<void> {
  const existing = await prisma.user.count();
  if (existing > 0) {
    console.log('[seed] Skipping admin (users already present)');
    return;
  }

  const email = process.env.INITIAL_ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.INITIAL_ADMIN_PASSWORD;

  if (!email || !password) {
    throw new Error(
      'INITIAL_ADMIN_EMAIL and INITIAL_ADMIN_PASSWORD must be set to seed the initial admin.',
    );
  }

  const hashed = await hash(password, BCRYPT_COST);
  await prisma.user.create({ data: { email, password: hashed } });
  console.log(`[seed] Admin: ${email}`);
}

async function seedAiSettings(prisma: PrismaClient): Promise<void> {
  const existing = await prisma.aiSettings.count();
  if (existing > 0) {
    console.log('[seed] Skipping AI settings (already present)');
    return;
  }

  const provider = process.env.INITIAL_AI_PROVIDER?.trim();
  const model = process.env.INITIAL_AI_MODEL?.trim();
  const apiKey = process.env.INITIAL_AI_API_KEY;

  if (!provider || !model || !apiKey) {
    console.log(
      '[seed] AI settings vars not set — leave empty (admin will configure via UI).',
    );
    return;
  }

  await prisma.aiSettings.create({
    data: {
      provider,
      model,
      apiKey: encrypt(apiKey),
      temperature: 0,
      maxRetries: 3,
      isActive: true,
    },
  });
  console.log(`[seed] AiSettings: ${provider} / ${model}`);
}

async function upsertSetting(
  prisma: PrismaClient,
  key: string,
  rawValue: string,
  isSecret: boolean,
): Promise<void> {
  const existing = await prisma.setting.findUnique({ where: { key } });
  if (existing) {
    console.log(`[seed] Skipping Setting '${key}' (already present)`);
    return;
  }
  const json = JSON.stringify(rawValue);
  const stored = isSecret ? encrypt(json) : json;
  await prisma.setting.create({
    data: { key, value: stored, isSecret },
  });
  console.log(`[seed] Setting: ${key}${isSecret ? ' (secret)' : ''}`);
}

async function seedSettings(prisma: PrismaClient): Promise<void> {
  const appUrl = process.env.APP_URL?.trim();
  const invenflowBaseUrl = process.env.INVENFLOW_BASE_URL?.trim();
  const invenflowToken = process.env.INVENFLOW_INITIAL_SERVICE_TOKEN?.trim();
  const fonnteToken = process.env.FONNTE_TOKEN?.trim();
  const fonnteTarget = process.env.ADMIN_WA_NUMBER?.trim();

  if (appUrl)
    await upsertSetting(prisma, KEY_APP_URL, appUrl, false);
  if (invenflowBaseUrl)
    await upsertSetting(prisma, KEY_INVENFLOW_BASE_URL, invenflowBaseUrl, false);
  if (invenflowToken)
    await upsertSetting(
      prisma,
      KEY_INVENFLOW_SERVICE_TOKEN,
      invenflowToken,
      true,
    );
  if (fonnteTarget)
    await upsertSetting(prisma, KEY_FONNTE_TARGET, fonnteTarget, false);
  if (fonnteToken)
    await upsertSetting(prisma, KEY_FONNTE_TOKEN, fonnteToken, true);
}

async function main() {
  const prisma = new PrismaClient();
  try {
    await seedAdmin(prisma);
    await seedAiSettings(prisma);
    await seedSettings(prisma);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

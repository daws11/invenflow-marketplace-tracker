// Initial admin + initial settings seed (PRD §15.1 step 4–6).
//
// Plain Node.js (CommonJS) so it can run inside the production runtime
// image without needing tsx or src/ resolved imports. The TypeScript
// version (seed.ts) remains for local-dev parity but production calls
// THIS file directly from start-prod.sh after `prisma migrate deploy`.
//
// Idempotent — every step skips if the underlying record is already
// present, so re-runs on container restart are safe (and expected).

const { hash } = require('bcryptjs');
const { PrismaClient } = require('@prisma/client');
const { createCipheriv, randomBytes } = require('node:crypto');

const BCRYPT_COST = 12;

// ---------------------------------------------------------------------------
// Inline AES-256-GCM encryption (must produce ciphertext compatible with
// apps/web/src/lib/encryption.ts so the runtime can decrypt these values).
// Format: base64( iv (12B) || ciphertext (n) || authTag (16B) )
// ---------------------------------------------------------------------------
const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;
const IV_LENGTH = 12;

function getKey() {
  const raw = process.env.ENCRYPTION_KEY;
  if (!raw || raw.length === 0) {
    throw new Error(
      'ENCRYPTION_KEY is not set. Generate one with `openssl rand -base64 32`.',
    );
  }
  const key = Buffer.from(raw, 'base64');
  if (key.length !== KEY_LENGTH) {
    throw new Error(
      `ENCRYPTION_KEY must decode to exactly ${KEY_LENGTH} bytes (got ${key.length}).`,
    );
  }
  return key;
}

function encrypt(plaintext) {
  const key = getKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, ct, tag]).toString('base64');
}

// ---------------------------------------------------------------------------
// Setting keys — must match SETTING_KEYS in apps/web/src/lib/settings.ts.
// ---------------------------------------------------------------------------
const KEY_APP_URL = 'app.url';
const KEY_INVENFLOW_BASE_URL = 'invenflow.baseUrl';
const KEY_INVENFLOW_SERVICE_TOKEN = 'invenflow.serviceToken';
const KEY_FONNTE_TOKEN = 'fonnte.token';
const KEY_FONNTE_TARGET = 'fonnte.target';

async function seedAdmin(prisma) {
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

async function seedAiSettings(prisma) {
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

async function upsertSetting(prisma, key, rawValue, isSecret) {
  const existing = await prisma.setting.findUnique({ where: { key } });
  if (existing) {
    console.log(`[seed] Skipping Setting '${key}' (already present)`);
    return;
  }
  const json = JSON.stringify(rawValue);
  const stored = isSecret ? encrypt(json) : json;
  await prisma.setting.create({ data: { key, value: stored, isSecret } });
  console.log(`[seed] Setting: ${key}${isSecret ? ' (secret)' : ''}`);
}

async function seedSettings(prisma) {
  const appUrl = process.env.APP_URL?.trim();
  const invenflowBaseUrl = process.env.INVENFLOW_BASE_URL?.trim();
  const invenflowToken = process.env.INVENFLOW_INITIAL_SERVICE_TOKEN?.trim();
  const fonnteToken = process.env.FONNTE_TOKEN?.trim();
  const fonnteTarget = process.env.ADMIN_WA_NUMBER?.trim();
  if (appUrl) await upsertSetting(prisma, KEY_APP_URL, appUrl, false);
  if (invenflowBaseUrl)
    await upsertSetting(prisma, KEY_INVENFLOW_BASE_URL, invenflowBaseUrl, false);
  if (invenflowToken)
    await upsertSetting(prisma, KEY_INVENFLOW_SERVICE_TOKEN, invenflowToken, true);
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

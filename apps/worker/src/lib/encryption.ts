// AES-256-GCM at-rest encryption helper (worker-side mirror of
// apps/web/src/lib/encryption.ts).
//
// Sharing decision (C1): Option B — duplicated in worker. See db.ts for the
// rationale. The web copy stays canonical; if it changes, mirror the change
// here. Both copies must agree on the wire format
//   base64( iv (12) || ciphertext (n) || authTag (16) )
// because rows encrypted by the web are decrypted by the worker.

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  type CipherGCM,
  type DecipherGCM,
} from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32; // bytes (AES-256)
const IV_LENGTH = 12; // bytes (GCM standard)
const AUTH_TAG_LENGTH = 16; // bytes

let cachedKey: Buffer | null = null;

function getKey(): Buffer {
  if (cachedKey) return cachedKey;

  const raw = process.env.ENCRYPTION_KEY;
  if (!raw || raw.length === 0) {
    throw new Error(
      'ENCRYPTION_KEY is not set. Generate one with `openssl rand -base64 32` and add it to your environment.',
    );
  }

  let key: Buffer;
  try {
    key = Buffer.from(raw, 'base64');
  } catch (err) {
    throw new Error(
      `ENCRYPTION_KEY is not valid base64: ${(err as Error).message}`,
    );
  }

  if (key.length !== KEY_LENGTH) {
    throw new Error(
      `ENCRYPTION_KEY must decode to exactly ${KEY_LENGTH} bytes (got ${key.length}). Generate one with \`openssl rand -base64 32\`.`,
    );
  }

  cachedKey = key;
  return key;
}

export function encrypt(plaintext: string): string {
  if (typeof plaintext !== 'string') {
    throw new TypeError('encrypt() expects a string');
  }
  const key = getKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv) as CipherGCM;
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, ciphertext, authTag]).toString('base64');
}

export function decrypt(ciphertext: string): string {
  if (typeof ciphertext !== 'string') {
    throw new TypeError('decrypt() expects a string');
  }
  const key = getKey();
  const buf = Buffer.from(ciphertext, 'base64');

  if (buf.length < IV_LENGTH + AUTH_TAG_LENGTH) {
    throw new Error(
      'Ciphertext is too short to contain IV + auth tag; refusing to decrypt.',
    );
  }

  const iv = buf.subarray(0, IV_LENGTH);
  const authTag = buf.subarray(buf.length - AUTH_TAG_LENGTH);
  const ct = buf.subarray(IV_LENGTH, buf.length - AUTH_TAG_LENGTH);

  const decipher = createDecipheriv(ALGORITHM, key, iv) as DecipherGCM;
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ct), decipher.final()]);
  return plaintext.toString('utf8');
}

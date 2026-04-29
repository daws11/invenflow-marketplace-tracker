// Round-trip and tamper tests for the AES-256-GCM helper.
//
// Run with:  node --test --import tsx apps/web/src/lib/encryption.test.ts
// (or `tsx --test apps/web/src/lib/encryption.test.ts` once tsx is installed).
//
// These tests intentionally do not depend on a global test runner config; they
// use Node's built-in `node:test` so they work in CI without extra deps.

import { strict as assert } from 'node:assert';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';

// Set the env var BEFORE importing the module under test so the cached key
// initializes against our test key instead of whatever the host has.
process.env.ENCRYPTION_KEY = randomBytes(32).toString('base64');

const { encrypt, decrypt, __testing } = await import('./encryption.js');

test('encrypt/decrypt round-trips a short ascii string', () => {
  const pt = 'hello world';
  const ct = encrypt(pt);
  assert.notEqual(ct, pt);
  assert.equal(decrypt(ct), pt);
});

test('encrypt/decrypt round-trips utf-8 (emoji + non-latin)', () => {
  const pt = 'inv_svc_abcDEF — Tokopedia 東京';
  assert.equal(decrypt(encrypt(pt)), pt);
});

test('encrypt produces a different ciphertext each call (random IV)', () => {
  const a = encrypt('same plaintext');
  const b = encrypt('same plaintext');
  assert.notEqual(a, b);
});

test('decrypt throws on tampered ciphertext (auth tag mismatch)', () => {
  const ct = encrypt('do not modify');
  // Flip a bit in the middle of the blob.
  const buf = Buffer.from(ct, 'base64');
  buf[__testing.IV_LENGTH + 1] = (buf[__testing.IV_LENGTH + 1] ?? 0) ^ 0x01;
  const tampered = buf.toString('base64');
  assert.throws(() => decrypt(tampered));
});

test('decrypt throws on truncated ciphertext', () => {
  assert.throws(() => decrypt('AAAA'));
});

test('missing ENCRYPTION_KEY throws a clear error', async () => {
  __testing.resetKeyCache();
  const saved = process.env.ENCRYPTION_KEY;
  delete process.env.ENCRYPTION_KEY;
  try {
    assert.throws(() => encrypt('x'), /ENCRYPTION_KEY/);
  } finally {
    process.env.ENCRYPTION_KEY = saved;
    __testing.resetKeyCache();
  }
});

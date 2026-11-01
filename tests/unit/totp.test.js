'use strict';
require('../helpers/env');
const test = require('node:test');
const assert = require('node:assert/strict');
const totp = require('../../lib/totp');

// RFC 6238 appendix B test vectors (SHA-1, secret "12345678901234567890", 8 digits).
test('TOTP matches the RFC 6238 test vectors', () => {
  const secret = Buffer.from('12345678901234567890');
  const vectors = [[59, '94287082'], [1111111109, '07081804'], [1111111111, '14050471'], [1234567890, '89005924'], [2000000000, '69279037'], [20000000000, '65353130']];
  for (const [time, expected] of vectors) assert.equal(totp.hotp(secret, Math.floor(time / 30), 8), expected);
});

test('base32 round-trips and rejects junk', () => {
  const buf = Buffer.from('hello world, this is a secret');
  assert.deepEqual(totp.base32Decode(totp.base32Encode(buf)), buf);
  assert.throws(() => totp.base32Decode('not*valid'));
});

test('a code verifies in its window and not outside it', () => {
  const secret = totp.generateSecret();
  const now = 1_700_000_000_000;
  const code = totp.totpAt(secret, now);
  assert.equal(totp.verifyTotp(secret, code, { timeMs: now }).ok, true);
  assert.equal(totp.verifyTotp(secret, code, { timeMs: now + 30_000 }).ok, true); // 1 step of drift
  assert.equal(totp.verifyTotp(secret, code, { timeMs: now + 120_000 }).ok, false);
});

test('a code that was already used cannot be replayed', () => {
  const secret = totp.generateSecret();
  const now = 1_700_000_000_000;
  const code = totp.totpAt(secret, now);
  const first = totp.verifyTotp(secret, code, { timeMs: now });
  assert.equal(first.ok, true);
  const again = totp.verifyTotp(secret, code, { timeMs: now, lastUsedStep: first.step });
  assert.equal(again.ok, false);
  assert.equal(again.replay, true);
});

test('malformed codes are rejected without throwing', () => {
  const secret = totp.generateSecret();
  for (const bad of ['', '12345', '1234567', 'abcdef', ' 123456', null, undefined, 123456]) {
    assert.equal(totp.verifyTotp(secret, bad).ok, false);
  }
});

test('otpauth URI and recovery codes have the expected shape', () => {
  const uri = totp.otpauthUri({ secret: 'ABCDEFGH', account: 'ann', issuer: 'AI Code Reviewer' });
  assert.match(uri, /^otpauth:\/\/totp\/AI%20Code%20Reviewer:ann\?/);
  assert.match(uri, /secret=ABCDEFGH/);
  const codes = totp.generateRecoveryCodes(10);
  assert.equal(new Set(codes).size, 10);
  for (const c of codes) assert.match(c, /^[a-z2-7]{4}(-[a-z2-7]{4}){3}$/);
  assert.equal(totp.normalizeRecoveryCode('ABCD EFGH-ijkl mnop'), 'abcd-efgh-ijkl-mnop');
});

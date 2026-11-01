'use strict';
require('../helpers/env');
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { encrypt, decrypt, sha256, randomToken, safeEqual, hmacHex } = require('../../lib/crypto');
const { parseCookies } = require('../../lib/cookies');

test('encrypt/decrypt round-trips and is not deterministic', () => {
  const t = 'gho_exampleToken1234567890';
  const a = encrypt(t);
  assert.notEqual(a, encrypt(t));
  assert.match(a, /^v2\./);
  assert.equal(decrypt(a), t);
});

test('tampering with ciphertext, tag or iv is detected', () => {
  const [v, iv, tag, data] = encrypt('secret-value').split('.');
  const flip = (s) => (s[0] === 'A' ? 'B' : 'A') + s.slice(1);
  for (const bad of [[v, flip(iv), tag, data], [v, iv, flip(tag), data], [v, iv, tag, flip(data)]]) {
    assert.throws(() => decrypt(bad.join('.')));
  }
  assert.throws(() => decrypt('garbage'));
});

test('keys are separated by purpose', () => {
  const sealed = encrypt('totp-secret', 'totp');
  assert.equal(decrypt(sealed, 'totp'), 'totp-secret');
  assert.throws(() => decrypt(sealed, 'github-token'));
});

test('values written by the previous version (v1) can still be read', () => {
  const key = crypto.createHash('sha256').update(process.env.SESSION_SECRET).digest();
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([c.update('old-token', 'utf8'), c.final()]);
  const legacy = ['v1', iv, c.getAuthTag(), data].map((p) => (Buffer.isBuffer(p) ? p.toString('base64url') : p)).join('.');
  assert.equal(decrypt(legacy), 'old-token');
  assert.throws(() => decrypt(legacy, 'totp'), 'v1 values are only valid as GitHub tokens');
});

test('hash / token helpers', () => {
  assert.equal(sha256('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.notEqual(randomToken(), randomToken());
  assert.ok(randomToken(32).length >= 43);
  assert.equal(hmacHex('recovery', 'x'), hmacHex('recovery', 'x'));
  assert.notEqual(hmacHex('recovery', 'x'), hmacHex('other', 'x'));
  assert.equal(safeEqual('abc', 'abc'), true);
  assert.equal(safeEqual('abc', 'abd'), false);
  assert.equal(safeEqual('abc', 'abcd'), false);
});

test('cookie parsing', () => {
  assert.deepEqual(parseCookies('a=1; b=hello%20world; c'), { a: '1', b: 'hello world' });
  assert.equal(parseCookies('x=%E0%A4%A').x, '%E0%A4%A');
  assert.deepEqual(parseCookies(undefined), {});
  assert.equal(parseCookies('s=first; s=second').s, 'first', 'duplicate cookie names: first one wins');
});

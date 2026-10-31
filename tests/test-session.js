// Run with: node tests/test-session.js  (also part of: npm test)
// Covers the pure parts of the GitHub login: token encryption + cookie parsing.
// (The OAuth redirect itself needs a real GitHub OAuth app, so it isn't tested here.)
process.env.SESSION_SECRET = 'test-secret-test-secret-test-secret-123';
const test = require('node:test');
const assert = require('node:assert/strict');
const { encrypt, decrypt, sha256, randomToken } = require('../lib/crypto');
const { parseCookies } = require('../lib/session');

test('encrypt/decrypt round-trips and is not deterministic', () => {
  const t = 'gho_exampleToken1234567890';
  const a = encrypt(t);
  const b = encrypt(t);
  assert.notEqual(a, b);
  assert.ok(!a.includes(t));
  assert.equal(decrypt(a), t);
});

test('tampered or wrong-key ciphertext is rejected', () => {
  const enc = encrypt('secret');
  const parts = enc.split('.');
  parts[3] = Buffer.from('tampered').toString('base64url');
  assert.throws(() => decrypt(parts.join('.')));
  process.env.SESSION_SECRET = 'a-completely-different-secret-value-999';
  assert.throws(() => decrypt(enc));
  process.env.SESSION_SECRET = 'test-secret-test-secret-test-secret-123';
});

test('parseCookies handles normal, encoded and empty headers', () => {
  assert.deepEqual(parseCookies(undefined), {});
  assert.deepEqual(parseCookies('a=1; acr_session=abc%20d; b=x=y'), { a: '1', acr_session: 'abc d', b: 'x=y' });
});

test('sha256 + randomToken', () => {
  assert.equal(sha256('a').length, 64);
  assert.notEqual(randomToken(), randomToken());
});

test('with no SESSION_SECRET set, a secret is generated once and reused', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const keep = process.env.SESSION_SECRET;
  delete process.env.SESSION_SECRET;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acr-'));
  process.env.SESSION_SECRET_FILE = path.join(dir, 'nested', 'session-secret');
  delete require.cache[require.resolve('../lib/crypto')];
  const fresh = require('../lib/crypto');
  const enc = fresh.encrypt('tok');
  assert.ok(fs.existsSync(process.env.SESSION_SECRET_FILE));
  // "restart": a new module instance reads the same file and can still decrypt
  delete require.cache[require.resolve('../lib/crypto')];
  assert.equal(require('../lib/crypto').decrypt(enc), 'tok');
  delete process.env.SESSION_SECRET_FILE;
  process.env.SESSION_SECRET = keep;
});

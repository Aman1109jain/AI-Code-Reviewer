'use strict';
require('../helpers/env');
const test = require('node:test');
const assert = require('node:assert/strict');
const pw = require('../../lib/password');

test('hash then verify; wrong password fails; salts differ', async () => {
  const a = await pw.hashPassword('Correct-Horse-Battery-9');
  const b = await pw.hashPassword('Correct-Horse-Battery-9');
  assert.notEqual(a, b);
  assert.match(a, /^scrypt\$32768\$8\$3\$/);
  assert.equal(await pw.verifyPassword('Correct-Horse-Battery-9', a), true);
  assert.equal(await pw.verifyPassword('correct-horse-battery-9', a), false);
  assert.equal(await pw.verifyPassword('', a), false);
});

test('garbage or tampered stored hashes never verify (and never throw)', async () => {
  for (const bad of ['', null, 'plain', 'scrypt$1$1$1$a$b', 'scrypt$99999999$8$3$AAAA$AAAA', 'bcrypt$x$y']) {
    assert.equal(await pw.verifyPassword('anything', bad), false);
  }
});

test('absurdly long passwords are refused instead of hashed', async () => {
  await assert.rejects(() => pw.hashPassword('a'.repeat(129)));
  assert.equal(await pw.verifyPassword('a'.repeat(5000), await pw.hashPassword('Correct-Horse-Battery-9')), false);
});

test('NFKC normalisation: visually identical passwords match', async () => {
  const h = await pw.hashPassword('Pässword-Test-123!');
  assert.equal(await pw.verifyPassword('Pa\u0308ssword-Test-123!', h), true);
});

test('password policy', () => {
  assert.ok(pw.checkPasswordPolicy('short1A!').length > 0);
  assert.ok(pw.checkPasswordPolicy('password1234').length > 0);
  assert.ok(pw.checkPasswordPolicy('alicealice-Secret1', { username: 'alicealice' }).length > 0);
  assert.ok(pw.checkPasswordPolicy('aaaaaaaaaaaa').length > 0);
  assert.deepEqual(pw.checkPasswordPolicy('Correct-Horse-Battery-9', { username: 'ann', email: 'ann@x.com' }), []);
  assert.deepEqual(pw.checkPasswordPolicy('four words make a long passphrase'), []);
});

test('temporary passwords satisfy the policy and are unique', () => {
  const seen = new Set();
  for (let i = 0; i < 50; i += 1) {
    const p = pw.generateTemporaryPassword();
    assert.deepEqual(pw.checkPasswordPolicy(p), []);
    seen.add(p);
  }
  assert.equal(seen.size, 50);
});

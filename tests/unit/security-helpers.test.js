'use strict';
require('../helpers/env');
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { verifySignature } = require('../../trigger/webhook-handler');
const { sanitizeComment } = require('../../delivery/github-comments');
const { normalizeFindings } = require('../../findings/validate');
const { computeToken, isTrustedOrigin } = require('../../lib/csrf');
const { TABLES, coerce, getTable, parsePk } = require('../../admin/registry');
const { load } = require('../../config/env');

const SECRET = 'webhook-test-secret-123456';
const sign = (body) => `sha256=${crypto.createHmac('sha256', SECRET).update(body).digest('hex')}`;

test('webhook signature: valid, wrong secret, tampered body, missing/garbled header', () => {
  const body = Buffer.from('{"action":"opened","n":1}');
  assert.equal(verifySignature(body, sign(body), SECRET), true);
  assert.equal(verifySignature(body, sign(body), 'another-secret-another-secret'), false);
  assert.equal(verifySignature(Buffer.from('{"action":"opened","n":2}'), sign(body), SECRET), false);
  for (const h of [undefined, '', 'sha256=', 'sha256=zz', 'sha1=abc', sign(body).slice(0, -2)]) assert.equal(verifySignature(body, h, SECRET), false);
  assert.equal(verifySignature(body, sign(body), ''), false);
  assert.equal(verifySignature('not a buffer', sign(body), SECRET), false);
});

test('webhook signature survives smee re-serialisation of < > & (and nothing else)', () => {
  // GitHub signs the text with \u003c escapes; smee forwards it with literal characters.
  const githubBytes = Buffer.from('{"title":"a \\u003cb\\u003e \\u0026 c"}');
  const viaSmee = Buffer.from(JSON.stringify(JSON.parse(githubBytes.toString())));
  assert.notEqual(githubBytes.toString(), viaSmee.toString());
  assert.equal(verifySignature(viaSmee, sign(githubBytes), SECRET), true);
  assert.equal(verifySignature(Buffer.from('{"title":"changed"}'), sign(githubBytes), SECRET), false);
});

test('comments cannot ping people and stay under the size limit', () => {
  assert.ok(!/@[a-z]/i.test(sanitizeComment('hey @octocat and @org/team')));
  assert.ok(sanitizeComment('x'.repeat(100000)).length < 61000);
  assert.equal(sanitizeComment('user@example.com'.replace('@', ' at ')), 'user at example.com');
});

test('AI / Semgrep output is forced into a safe shape', () => {
  const out = normalizeFindings([
    { filePath: 'a.js', severity: 'CRITICAL', category: 'weird', issue: 'bad\u0000 thing', suggestion: 's' },
    { filePath: 'b.js', severity: 'blocking', category: 'security', issue: '', suggestion: 'x' },
    null, 'str', 5, { issue: 'no path' },
  ]);
  assert.equal(out.length, 2);
  assert.equal(out[0].severity, 'warning');
  assert.equal(out[0].category, 'maintainability');
  assert.equal(out[0].issue, 'bad thing');
  assert.equal(out[1].filePath, '(unknown file)');
  assert.deepEqual(normalizeFindings('nope'), []);
  assert.equal(normalizeFindings(Array.from({ length: 500 }, () => ({ issue: 'x' }))).length, 200);
  assert.equal(normalizeFindings([{ issue: 'x'.repeat(99999) }])[0].issue.length, 4000);
});

test('CSRF token depends on both secret and session', () => {
  const t1 = computeToken('secretA', 'sess1|');
  assert.equal(t1, computeToken('secretA', 'sess1|'));
  assert.notEqual(t1, computeToken('secretB', 'sess1|'));
  assert.notEqual(t1, computeToken('secretA', 'sess2|'));
});

test('origin check: same host and allow-list pass, others fail', () => {
  const req = (headers) => ({ get: (n) => headers[n.toLowerCase()] });
  assert.equal(isTrustedOrigin(req({ origin: 'http://localhost:5173', host: 'localhost:3000' })), true); // allow-list
  assert.equal(isTrustedOrigin(req({ origin: 'https://app.example.com', host: 'app.example.com' })), true); // same host
  assert.equal(isTrustedOrigin(req({ origin: 'https://evil.example', host: 'app.example.com' })), false);
  assert.equal(isTrustedOrigin(req({ origin: 'null', host: 'app.example.com' })), false);
  assert.equal(isTrustedOrigin(req({ referer: 'https://evil.example/x', host: 'app.example.com' })), false);
  assert.equal(isTrustedOrigin(req({ host: 'app.example.com' })), null);
});

test('admin registry: only declared tables/columns, strict value checks', () => {
  assert.throws(() => getTable('admin_users'), /Unknown table/);
  assert.throws(() => getTable('reviews; DROP TABLE reviews'), /Unknown table/);
  assert.throws(() => getTable('__proto__'), /Unknown table/);
  assert.ok(!TABLES.github_users.visible.some((c) => c.name === 'access_token_enc'), 'token ciphertext is never exposed');
  assert.ok(!TABLES.user_sessions.visible.some((c) => c.name === 'session_hash'), 'session hashes are never exposed');
  const sev = TABLES.findings.byName.get('severity');
  assert.deepEqual(coerce(sev, 'blocking'), { value: 'blocking', cast: '' });
  assert.throws(() => coerce(sev, "blocking'; --"), /must be one of/);
  const score = TABLES.reviews.byName.get('overall_score');
  assert.throws(() => coerce(score, 101));
  assert.throws(() => coerce(score, '5; DROP'));
  assert.equal(coerce(score, '42').value, 42);
  assert.throws(() => coerce(TABLES.reviews.byName.get('repo_name'), 'a\u0000b'));
  assert.throws(() => coerce(TABLES.github_users.byName.get('avatar_url'), 'javascript:alert(1)'));
  assert.throws(() => parsePk(TABLES.reviews, '1 OR 1=1'));
  assert.equal(parsePk(TABLES.reviews, '12'), 12);
});

test('configuration fails fast on weak or missing production secrets', () => {
  assert.throws(() => load({ NODE_ENV: 'production' }), /SESSION_SECRET is required/);
  assert.throws(() => load({ NODE_ENV: 'production', SESSION_SECRET: 'short' }), /at least 32/);
  assert.throws(() => load({ SESSION_SECRET: 'x'.repeat(40), ALLOWED_ORIGINS: 'not a url' }), /ALLOWED_ORIGINS/);
  const cfg = load({ NODE_ENV: 'production', SESSION_SECRET: 'x'.repeat(40), TRUST_PROXY: '1', SMEE_URL: '' });
  assert.equal(cfg.isProd, true);
  assert.equal(cfg.trustProxy, 1);
  assert.equal(cfg.serveClient, true);
  assert.equal(cfg.databaseSsl, 'verify');
});

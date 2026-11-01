'use strict';
const { skip, start } = require('../helpers/harness');
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const store = require('../../admin/store');
const pw = require('../../lib/password');
const totp = require('../../lib/totp');
const { decrypt, sha256 } = require('../../lib/crypto');
const { upsertUser } = require('../../lib/session');
const { createReviewWithFindings } = require('../../findings/db');

const PASSWORD = 'Correct-Horse-Battery-9';
let env;
let superadmin;

test.before(async () => {
  if (skip) return;
  env = await start();
  superadmin = await store.createAdmin({ username: 'root.admin', email: 'root@example.com', passwordHash: await pw.hashPassword(PASSWORD), role: 'superadmin' });
});
test.after(async () => { if (env) await env.stop(); });

// Signs an admin client all the way in (password + MFA). Returns the TOTP secret.
async function fullLogin(c, username, password, secret) {
  let r = await c.post('/api/admin/auth/login', { username, password });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  if (r.data.stage === 'mfa_setup') {
    const setup = await c.post('/api/admin/auth/mfa/setup', {});
    secret = setup.data.secret;
    r = await c.post('/api/admin/auth/mfa/enable', { code: totp.totpAt(secret) });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.recoveryCodes.length, 10);
    return { secret, recoveryCodes: r.data.recoveryCodes };
  }
  assert.equal(r.data.stage, 'mfa_pending');
  // Replay protection (tested on its own above) would reject a code from the same
  // 30-second step as an earlier sign-in, so clear the marker for this helper.
  await env.pool.query('UPDATE admin_users SET totp_last_step = NULL WHERE username = $1', [username]);
  r = await c.post('/api/admin/auth/mfa/verify', { code: totp.totpAt(secret) });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return { secret };
}

test('anonymous visitors cannot read anything sensitive', { skip }, async () => {
  const c = env.client();
  for (const path of ['/api/reviews', '/api/reviews/1/findings', '/api/analytics/severity', '/api/events', '/api/github/repos', '/api/admin/db/tables', '/api/admin/users', '/api/admin/me']) {
    const r = await c.get(path);
    assert.equal(r.status, 401, `${path} should require sign-in`);
  }
  assert.equal((await c.get('/api/tables')).status, 404, 'the old public table dump is gone');
  assert.equal((await c.get('/api/tables/github_users')).status, 404);
  const status = await c.get('/api/github/status');
  assert.deepEqual(status.data, { connected: false });
  const unknown = await c.get('/api/does-not-exist');
  assert.equal(unknown.status, 404);
  assert.equal(unknown.headers.get('content-type').includes('json'), true);
});

test('security headers are present and the framework is not advertised', { skip }, async () => {
  const r = await env.client().get('/api/csrf');
  const h = r.headers;
  assert.match(h.get('content-security-policy'), /default-src 'self'/);
  assert.match(h.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.match(h.get('content-security-policy'), /script-src 'self'(;|$)/);
  assert.equal(h.get('x-content-type-options'), 'nosniff');
  assert.equal(h.get('x-frame-options'), 'DENY');
  assert.equal(h.get('referrer-policy'), 'no-referrer');
  assert.equal(h.get('cache-control'), 'no-store');
  assert.equal(h.get('x-powered-by'), null);
  assert.ok(h.get('permissions-policy'));
});

test('CORS: only allow-listed origins get credentialed access', { skip }, async () => {
  const c = env.client();
  const good = await c.get('/api/csrf', { headers: { origin: 'http://localhost:5173' } });
  assert.equal(good.headers.get('access-control-allow-origin'), 'http://localhost:5173');
  assert.equal(good.headers.get('access-control-allow-credentials'), 'true');
  const evil = await c.get('/api/csrf', { origin: 'https://evil.example' });
  assert.equal(evil.headers.get('access-control-allow-origin'), null);
});

test('CSRF: state-changing requests need the token AND a trusted origin', { skip }, async () => {
  const c = env.client();
  assert.equal((await c.post('/api/auth/logout', {}, { csrf: false })).status, 403, 'no token');
  assert.equal((await c.post('/api/auth/logout', {}, { csrf: false, headers: { 'x-csrf-token': 'forged' } })).status, 403, 'forged token');
  await c.refreshCsrf();
  assert.equal((await c.post('/api/auth/logout', {}, { origin: 'https://evil.example' })).status, 403, 'token ok but request came from another site');
  const other = env.client();
  await other.refreshCsrf();
  assert.equal((await c.post('/api/auth/logout', {}, { headers: { 'x-csrf-token': other.csrf } })).status, 403, "someone else's token");
  assert.equal((await c.post('/api/auth/logout', {})).status, 200, 'legitimate request');
});

test('input validation: unknown fields, wrong types, bad JSON and oversized bodies are rejected', { skip }, async () => {
  const c = env.client();
  assert.equal((await c.post('/api/admin/auth/login', { username: 'a', password: 'b', admin: true })).status, 400, 'mass assignment');
  assert.equal((await c.post('/api/admin/auth/login', { username: ['x'], password: 5 })).status, 400);
  assert.equal((await c.post('/api/auth/github/token', { token: 'short' })).status, 400);
  assert.equal((await c.post('/api/auth/github/token', { token: 'ghp_' + 'a'.repeat(30) + '<script>' })).status, 400);
  const bad = await c.request('POST', '/api/admin/auth/login', { raw: '{not json', headers: { 'content-type': 'application/json' } });
  assert.equal(bad.status, 400);
  assert.ok(!JSON.stringify(bad.data).includes('SyntaxError'), 'no parser internals leak');
  const big = await c.post('/api/admin/auth/login', { username: 'a', password: 'x'.repeat(200 * 1024) });
  assert.equal(big.status, 413);
});

test('admin sign-in: generic errors, MFA enrolment, recovery codes, replay protection', { skip }, async () => {
  const c = env.client();
  const wrongPw = await c.post('/api/admin/auth/login', { username: 'root.admin', password: 'wrong-password-123' });
  const noUser = await c.post('/api/admin/auth/login', { username: 'nobody.here', password: 'wrong-password-123' });
  assert.equal(wrongPw.status, 401);
  assert.deepEqual(wrongPw.data, noUser.data, 'same message whether or not the account exists');

  let r = await c.post('/api/admin/auth/login', { username: 'ROOT.admin', password: PASSWORD });
  assert.equal(r.data.stage, 'mfa_setup');
  const cookieBefore = c.cookie('acr_admin');
  assert.equal((await c.get('/api/admin/users')).status, 403, 'password alone is not enough');
  assert.equal((await c.get('/api/admin/db/tables')).status, 403);

  const setup = await c.post('/api/admin/auth/mfa/setup', {});
  assert.match(setup.data.qr, /^data:image\/png;base64,/);
  assert.match(setup.data.otpauthUri, /^otpauth:\/\/totp\//);
  const wrong = await c.post('/api/admin/auth/mfa/enable', { code: '000000' });
  assert.equal(wrong.status, 401);
  r = await c.post('/api/admin/auth/mfa/enable', { code: totp.totpAt(setup.data.secret) });
  assert.equal(r.status, 200);
  const recoveryCodes = r.data.recoveryCodes;
  assert.notEqual(c.cookie('acr_admin'), cookieBefore, 'session id is replaced after the MFA step (no fixation)');
  assert.equal((await c.get('/api/admin/me')).status, 200);

  // Stored secrets are encrypted / hashed, never plain.
  const { rows } = await env.pool.query('SELECT totp_secret_enc FROM admin_users WHERE id = $1', [superadmin.id]);
  assert.ok(!rows[0].totp_secret_enc.includes(setup.data.secret));
  assert.equal(decrypt(rows[0].totp_secret_enc, 'totp'), setup.data.secret);
  const stored = await env.pool.query('SELECT code_hash FROM admin_recovery_codes WHERE admin_id = $1', [superadmin.id]);
  assert.equal(stored.rows.length, 10);
  assert.ok(!recoveryCodes.some((code) => stored.rows.some((s) => s.code_hash.includes(code.replace(/-/g, '')))));
  const tokenInDb = await env.pool.query('SELECT token_hash FROM admin_sessions WHERE admin_id = $1', [superadmin.id]);
  assert.ok(tokenInDb.rows.some((s) => s.token_hash === sha256(c.cookie('acr_admin'))), 'only the hash of the cookie is stored');

  // New sign-in: a TOTP code works once.
  await c.post('/api/admin/auth/logout', {});
  assert.equal((await c.get('/api/admin/me')).status, 401);
  await c.post('/api/admin/auth/login', { username: 'root.admin', password: PASSWORD });
  const code = totp.totpAt(setup.data.secret, Date.now() + 30000);
  const c2 = env.client();
  await c.post('/api/admin/auth/mfa/verify', { code });
  assert.equal((await c.get('/api/admin/me')).status, 200);
  await c2.post('/api/admin/auth/login', { username: 'root.admin', password: PASSWORD });
  assert.equal((await c2.post('/api/admin/auth/mfa/verify', { code })).status, 401, 'the same code cannot be used twice');

  // ...and a recovery code works once.
  const c3 = env.client();
  await c3.post('/api/admin/auth/login', { username: 'root.admin', password: PASSWORD });
  assert.equal((await c3.post('/api/admin/auth/mfa/verify', { recoveryCode: recoveryCodes[0] })).status, 200);
  const c4 = env.client();
  await c4.post('/api/admin/auth/login', { username: 'root.admin', password: PASSWORD });
  assert.equal((await c4.post('/api/admin/auth/mfa/verify', { recoveryCode: recoveryCodes[0] })).status, 401, 'recovery codes are single use');
  superadmin.secret = setup.data.secret;
});

test('brute force: the account locks after repeated failures, and unlock works', { skip }, async () => {
  await store.createAdmin({ username: 'victim', email: 'victim@example.com', passwordHash: await pw.hashPassword(PASSWORD) });
  const c = env.client();
  for (let i = 0; i < 5; i += 1) assert.equal((await c.post('/api/admin/auth/login', { username: 'victim', password: `wrong-guess-${i}-xyz` })).status, 401);
  const locked = await c.post('/api/admin/auth/login', { username: 'victim', password: PASSWORD });
  assert.equal(locked.status, 401, 'correct password is refused while locked');
  const user = await store.findByUsername('victim');
  assert.ok(store.isLocked(user));
  await store.unlock(user.id);
  assert.equal((await c.post('/api/admin/auth/login', { username: 'victim', password: PASSWORD })).status, 200);
  const log = await env.pool.query(`SELECT action FROM admin_audit_log WHERE admin_username = 'victim'`);
  assert.ok(log.rows.some((r) => r.action === 'account.locked'));
});

test('MFA guessing: five wrong codes end the sign-in', { skip }, async () => {
  const c = env.client();
  await c.post('/api/admin/auth/login', { username: 'root.admin', password: PASSWORD });
  let last;
  for (let i = 0; i < 5; i += 1) last = await c.post('/api/admin/auth/mfa/verify', { code: '000000' });
  assert.equal(last.data.code, 'mfa_session_expired');
  assert.equal((await c.get('/api/admin/auth/session')).data.authenticated, false);
  await store.unlock(superadmin.id);
});

test('authorization: roles, temporary passwords, forced password change and last-superadmin protection', { skip }, async () => {
  await store.unlock(superadmin.id);
  const boss = env.client();
  await fullLogin(boss, 'root.admin', PASSWORD, superadmin.secret);

  const weakName = await boss.post('/api/admin/users', { username: 'x', email: 'not-an-email' });
  assert.equal(weakName.status, 400);
  const created = await boss.post('/api/admin/users', { username: 'second.admin', email: 'Second@Example.com' });
  assert.equal(created.status, 201);
  assert.equal(created.data.user.role, 'admin');
  assert.equal(created.data.user.email, 'second@example.com');
  assert.ok(!('password_hash' in created.data.user));
  const temp = created.data.temporaryPassword;
  assert.deepEqual(pw.checkPasswordPolicy(temp), []);
  assert.equal((await boss.post('/api/admin/users', { username: 'second.admin', email: 'dup@example.com' })).status, 409);

  // The new admin must replace the temporary password before anything else.
  const bob = env.client();
  let r = await bob.post('/api/admin/auth/login', { username: 'second.admin', password: temp });
  assert.equal(r.data.stage, 'password_change');
  assert.equal((await bob.get('/api/admin/users')).status, 403);
  assert.equal((await bob.post('/api/admin/auth/password/initial', { currentPassword: temp, newPassword: 'password1234' })).status, 400, 'weak password refused');
  assert.equal((await bob.post('/api/admin/auth/password/initial', { currentPassword: temp, newPassword: temp })).status, 400, 'must differ from the temporary one');
  r = await bob.post('/api/admin/auth/password/initial', { currentPassword: temp, newPassword: 'My-Own-Strong-Pass-77' });
  assert.equal(r.data.stage, 'mfa_setup');
  const setup = await bob.post('/api/admin/auth/mfa/setup', {});
  r = await bob.post('/api/admin/auth/mfa/enable', { code: totp.totpAt(setup.data.secret) });
  assert.equal(r.status, 200);

  // Plain admins can add admins, but cannot manage other accounts or make superadmins.
  assert.equal((await bob.post('/api/admin/users', { username: 'third.admin', email: 'third@example.com' })).status, 201);
  assert.equal((await bob.post('/api/admin/users', { username: 'sneaky', email: 'sneaky@example.com', role: 'superadmin' })).status, 403);
  const list = (await bob.get('/api/admin/users')).data.users;
  const rootRow = list.find((u) => u.username === 'root.admin');
  assert.equal((await bob.patch(`/api/admin/users/${rootRow.id}`, { isActive: false, currentPassword: 'My-Own-Strong-Pass-77' })).status, 403);
  assert.equal((await bob.del(`/api/admin/users/${rootRow.id}`, { currentPassword: 'My-Own-Strong-Pass-77' })).status, 403);
  assert.equal((await bob.post(`/api/admin/users/${rootRow.id}/reset-password`, { currentPassword: 'My-Own-Strong-Pass-77' })).status, 403);
  assert.ok((await env.pool.query(`SELECT 1 FROM admin_audit_log WHERE action = 'authz.denied'`)).rowCount >= 3, 'denied attempts are audited');

  // Superadmin powers need the password again, and protect the last superadmin.
  assert.equal((await boss.del(`/api/admin/users/${rootRow.id}`, { currentPassword: PASSWORD })).status, 400, 'cannot delete yourself');
  assert.equal((await boss.patch(`/api/admin/users/${rootRow.id}`, { role: 'admin', currentPassword: PASSWORD })).status, 400, 'cannot demote yourself');
  const bobRow = list.find((u) => u.username === 'second.admin');
  assert.equal((await boss.patch(`/api/admin/users/${bobRow.id}`, { isActive: false, currentPassword: 'wrong-password-1234' })).status, 403, 'wrong re-auth password');
  assert.equal((await boss.patch(`/api/admin/users/${bobRow.id}`, { role: 'superadmin', currentPassword: PASSWORD })).status, 200);
  assert.equal((await boss.patch(`/api/admin/users/${bobRow.id}`, { isActive: false, currentPassword: PASSWORD })).status, 200, 'two superadmins: one may be disabled');
  assert.equal((await bob.get('/api/admin/me')).status, 401, 'disabling an account ends its sessions immediately');
  const reset = await boss.post(`/api/admin/users/${bobRow.id}/reset-password`, { currentPassword: PASSWORD });
  assert.deepEqual(pw.checkPasswordPolicy(reset.data.temporaryPassword), []);
});

test('changing your own password signs out your other sessions', { skip }, async () => {
  const a = env.client();
  const b = env.client();
  await fullLogin(a, 'root.admin', PASSWORD, superadmin.secret);
  await store.unlock(superadmin.id);
  const second = await b.post('/api/admin/auth/login', { username: 'root.admin', password: PASSWORD });
  assert.equal(second.data.stage, 'mfa_pending');
  await env.pool.query(`UPDATE admin_users SET totp_last_step = NULL WHERE username = 'root.admin'`);
  await b.post('/api/admin/auth/mfa/verify', { code: totp.totpAt(superadmin.secret) });
  assert.equal((await b.get('/api/admin/me')).status, 200);
  const before = a.cookie('acr_admin');
  assert.equal((await a.post('/api/admin/me/password', { currentPassword: 'nope-nope-nope-1', newPassword: 'Another-Strong-Pass-55' })).status, 403);
  assert.equal((await a.post('/api/admin/me/password', { currentPassword: PASSWORD, newPassword: 'Another-Strong-Pass-55' })).status, 200);
  assert.notEqual(a.cookie('acr_admin'), before);
  assert.equal((await a.get('/api/admin/me')).status, 200);
  assert.equal((await b.get('/api/admin/me')).status, 401);
  assert.equal((await a.post('/api/admin/me/password', { currentPassword: 'Another-Strong-Pass-55', newPassword: PASSWORD })).status, 200);
});

test('admin database console: ACID behaviour, hidden secrets, injection attempts', { skip }, async () => {
  const gh = await upsertUser({ githubId: 424242, login: 'octo', name: 'Octo', avatarUrl: 'https://example.com/a.png', token: 'ghp_secrettokenvalue1234567890' });
  const rid = await createReviewWithFindings({ sourceType: 'github_pr', repoOwner: 'octo', repoName: 'repo', prNumber: 7, overallScore: 80, ownerUserId: gh }, [
    { filePath: 'a.js', severity: 'warning', category: 'security', issue: 'one', suggestion: 's' },
    { filePath: 'b.js', severity: 'nitpick', category: 'readability', issue: 'two', suggestion: 's' },
  ]);
  const c = env.client();
  await fullLogin(c, 'root.admin', PASSWORD, superadmin.secret);

  const meta = await c.get('/api/admin/db/tables');
  const names = meta.data.tables.map((t) => t.name);
  assert.deepEqual(names, ['reviews', 'findings', 'github_users', 'user_sessions', 'admin_audit_log', 'schema_migrations']);
  assert.ok(!names.includes('admin_users'), 'password hashes are not browsable');

  const users = await c.get('/api/admin/db/tables/github_users/rows');
  assert.equal(users.data.rows.length, 1);
  assert.ok(!('access_token_enc' in users.data.rows[0]), 'encrypted tokens are never returned');
  assert.ok(!JSON.stringify(users.data).includes('ghp_secret'));

  const review = (await c.get(`/api/admin/db/tables/reviews/rows/${rid}`)).data.row;
  const findings = (await c.get('/api/admin/db/tables/findings/rows?sort=id&dir=asc')).data.rows;
  assert.equal(findings.length, 2);

  // Atomicity: the second operation is invalid, so the first must not be applied.
  let r = await c.post('/api/admin/db/transactions', { ops: [
    { op: 'update', table: 'reviews', id: rid, expectedVersion: review.row_version, values: { overall_score: 10 } },
    { op: 'insert', table: 'findings', values: { review_id: rid, severity: 'catastrophic' } },
  ] });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /Operation 2/);
  assert.match(r.data.error, /Nothing was saved/);
  assert.equal((await c.get(`/api/admin/db/tables/reviews/rows/${rid}`)).data.row.overall_score, 80, 'first change was rolled back');

  // Consistency: a database-level failure (foreign key) also rolls everything back.
  r = await c.post('/api/admin/db/transactions', { ops: [
    { op: 'update', table: 'reviews', id: rid, expectedVersion: review.row_version, values: { overall_score: 11 } },
    { op: 'insert', table: 'findings', values: { review_id: 999999, severity: 'warning' } },
  ] });
  assert.equal(r.status, 409);
  assert.equal((await c.get(`/api/admin/db/tables/reviews/rows/${rid}`)).data.row.overall_score, 80);

  // A valid multi-table transaction commits as one unit.
  r = await c.post('/api/admin/db/transactions', { ops: [
    { op: 'update', table: 'reviews', id: rid, expectedVersion: review.row_version, values: { overall_score: 55 } },
    { op: 'insert', table: 'findings', values: { review_id: rid, file_path: 'c.js', severity: 'blocking', category: 'security', issue: 'added by admin' } },
    { op: 'delete', table: 'findings', id: findings[1].id, expectedVersion: findings[1].row_version },
  ] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.committed, 3);
  const after = (await c.get(`/api/admin/db/tables/reviews/rows/${rid}`)).data.row;
  assert.equal(after.overall_score, 55);
  assert.equal(after.row_version, review.row_version + 1);
  assert.equal((await env.pool.query('SELECT COUNT(*)::int AS n FROM findings WHERE review_id = $1', [rid])).rows[0].n, 2);
  const audit = await env.pool.query(`SELECT details FROM admin_audit_log WHERE action = 'db.transaction' ORDER BY id DESC LIMIT 1`);
  assert.equal(audit.rows[0].details.ops.length, 3);

  // Isolation / lost-update protection: a stale version is refused...
  r = await c.post('/api/admin/db/transactions', { ops: [{ op: 'update', table: 'reviews', id: rid, expectedVersion: review.row_version, values: { overall_score: 1 } }] });
  assert.equal(r.status, 409);
  assert.equal(r.data.code, 'version_conflict');
  // ...and two simultaneous edits of the same version: exactly one wins.
  const fresh = (await c.get(`/api/admin/db/tables/reviews/rows/${rid}`)).data.row;
  const race = await Promise.all([20, 30].map((score) => c.post('/api/admin/db/transactions', { ops: [{ op: 'update', table: 'reviews', id: rid, expectedVersion: fresh.row_version, values: { overall_score: score } }] })));
  assert.deepEqual(race.map((x) => x.status).sort(), [200, 409]);

  // Cascade + durability: deleting a review removes its findings.
  const row = (await c.get(`/api/admin/db/tables/reviews/rows/${rid}`)).data.row;
  r = await c.post('/api/admin/db/transactions', { ops: [{ op: 'delete', table: 'reviews', id: rid, expectedVersion: row.row_version }] });
  assert.equal(r.status, 200);
  assert.equal((await env.pool.query('SELECT COUNT(*)::int AS n FROM findings WHERE review_id = $1', [rid])).rows[0].n, 0);

  // Guard rails: read-only tables, hidden/system columns, unknown tables, missing version.
  const bad = async (op) => (await c.post('/api/admin/db/transactions', { ops: [op] })).status;
  assert.equal(await bad({ op: 'delete', table: 'admin_audit_log', id: 1 }), 403);
  assert.equal(await bad({ op: 'insert', table: 'admin_audit_log', values: { action: 'x' } }), 403);
  assert.equal(await bad({ op: 'update', table: 'github_users', id: gh, expectedVersion: 1, values: { access_token_enc: 'x' } }), 400);
  assert.equal(await bad({ op: 'update', table: 'github_users', id: gh, expectedVersion: 1, values: { row_version: 99 } }), 400);
  assert.equal(await bad({ op: 'insert', table: 'github_users', values: { login: 'x' } }), 403);
  assert.equal(await bad({ op: 'insert', table: 'admin_users', values: { username: 'x' } }), 404);
  assert.equal(await bad({ op: 'update', table: 'github_users', id: gh, values: { login: 'octo2' } }), 400, 'expectedVersion required');
  assert.equal(await bad({ op: 'drop', table: 'reviews' }), 400);
  assert.equal(await bad({ op: 'insert', table: 'findings', values: { review_id: 1, severity: 'warning', evil: 1 } }), 400);

  // SQL injection attempts are inert: names are allow-listed and values are parameters.
  assert.equal((await c.get('/api/admin/db/tables/reviews/rows?sort=id;DROP TABLE reviews')).status, 400);
  assert.equal((await c.get('/api/admin/db/tables/reviews;DROP/rows')).status, 404);
  assert.equal((await c.get('/api/admin/db/tables/reviews/rows/1 OR 1=1')).status, 400);
  const inj = await c.get(`/api/admin/db/tables/reviews/rows?q=${encodeURIComponent("'; DROP TABLE reviews; --")}`);
  assert.equal(inj.status, 200);
  assert.equal(inj.data.total, 0);
  assert.equal((await env.pool.query(`SELECT to_regclass('public.reviews') AS t`)).rows[0].t, 'reviews');
  await c.post('/api/admin/db/transactions', { ops: [{ op: 'update', table: 'github_users', id: gh, expectedVersion: 1, values: { login: "x'); DELETE FROM reviews; --" } }] });
  assert.equal((await env.pool.query('SELECT login FROM github_users WHERE id = $1', [gh])).rows[0].login, 'octo', 'rejected by the format rule, not executed');
});

test('visitors only see their own reviews (no IDOR), and nobody can use Quick Check anonymously', { skip }, async () => {
  const mk = async (githubId, login) => {
    const id = await upsertUser({ githubId, login, name: login, avatarUrl: null, token: `ghp_token_for_${login}_0123456789` });
    const raw = crypto.randomBytes(32).toString('base64url');
    await env.pool.query(`INSERT INTO user_sessions (session_hash, user_id, expires_at) VALUES ($1, $2, NOW() + INTERVAL '1 day')`, [sha256(raw), id]);
    const c = env.client();
    c.jar.set('acr_session', raw);
    return { id, c };
  };
  const alice = await mk(1001, 'alice');
  const mallory = await mk(1002, 'mallory');
  const aliceReview = await createReviewWithFindings({ sourceType: 'quick_check', fileName: 'secret.py', overallScore: 90, diffText: 'SECRET DIFF', sourceCode: 'SECRET CODE', ownerUserId: alice.id }, [
    { filePath: 'secret.py', severity: 'warning', category: 'security', issue: 'x', suggestion: 'y' },
  ]);

  const mine = await alice.c.get('/api/reviews');
  assert.equal(mine.data.length, 1);
  assert.ok(!('diff_text' in mine.data[0]) && !('source_code' in mine.data[0]), 'the list never ships source code');
  assert.deepEqual((await mallory.c.get('/api/reviews')).data, []);
  assert.equal((await alice.c.get(`/api/reviews/${aliceReview}/findings`)).status, 200);
  assert.equal((await mallory.c.get(`/api/reviews/${aliceReview}/findings`)).status, 404, "someone else's review looks like a missing one");
  assert.equal((await mallory.c.get('/api/reviews/abc/findings')).status, 400);
  assert.deepEqual((await mallory.c.get('/api/analytics/severity')).data, []);
  assert.equal((await alice.c.get('/api/analytics/severity')).data[0].count, 1);

  const pr = { owner: 'mallory', repo: 'repo', branchName: 'x' };
  assert.equal((await mallory.c.post(`/api/quick-review/${aliceReview}/create-pr`, pr)).status, 404, 'cannot publish another user\'s code');
  assert.equal((await env.client().post(`/api/quick-review/${aliceReview}/create-pr`, pr)).status, 401);
  assert.equal((await env.client().post('/api/quick-review', { code: 'print(1)' })).status, 401, 'AI quota cannot be used anonymously');
  assert.equal((await alice.c.post('/api/quick-review', { code: 'x', extra: 1 })).status, 400);
  assert.equal((await alice.c.post('/api/quick-review', { files: [{ path: '../../etc/passwd', content: 'x' }] })).status, 400);
  assert.equal((await alice.c.post(`/api/quick-review/${aliceReview}/create-pr`, { owner: '../evil', repo: 'r', branchName: 'b' })).status, 400, 'owner is validated before it can reach a URL');
  assert.equal((await alice.c.post(`/api/quick-review/${aliceReview}/create-pr`, { owner: 'o', repo: 'r', branchName: 'a..b' })).status, 400);

  // Logging out kills the session server-side.
  const stolen = alice.c.cookie('acr_session');
  assert.equal((await alice.c.post('/api/auth/logout', {})).status, 200);
  const replay = env.client();
  replay.jar.set('acr_session', stolen);
  assert.equal((await replay.get('/api/reviews')).status, 401, 'a copied cookie is useless after sign-out');

  // Server-sent events are only for signed-in users and only carry their own events.
  assert.equal((await env.client().get('/api/events')).status, 401);
});

test('webhook: only correctly signed GitHub deliveries are accepted', { skip }, async () => {
  const c = env.client();
  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  const send = (payload, { event = 'pull_request', sig, delivery } = {}) => {
    const body = JSON.stringify(payload);
    const signature = sig === undefined ? `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}` : sig;
    return c.request('POST', '/webhook/github', { raw: body, csrf: false, origin: null, headers: { 'content-type': 'application/json', 'x-github-event': event, 'x-hub-signature-256': signature, ...(delivery ? { 'x-github-delivery': delivery } : {}) } });
  };
  const closed = { action: 'closed', repository: { name: 'r', owner: { login: 'o' } }, pull_request: { number: 1 } };
  assert.equal((await send(closed, { sig: 'sha256=' + 'a'.repeat(64) })).status, 401, 'wrong signature');
  assert.equal((await send(closed, { sig: '' })).status, 401, 'empty signature');
  assert.equal((await c.request('POST', '/webhook/github', { raw: JSON.stringify(closed), csrf: false, origin: null, headers: { 'content-type': 'application/json' } })).status, 401, 'no signature at all');
  assert.equal((await send(closed)).status, 202);
  assert.equal((await send({ zen: 'x' }, { event: 'ping' })).status, 200);
  assert.equal((await send(closed, { event: 'issues' })).status, 202);
  assert.equal((await send({ action: 'opened', repository: { name: '../x', owner: { login: 'o' } }, pull_request: { number: 1 } }, { delivery: 'd-1' })).status, 400, 'owner/repo are validated before use');
  assert.equal((await send({ action: 'opened', repository: { name: 'r', owner: { login: 'o' } }, pull_request: { number: -5 } })).status, 400);
  assert.equal((await send(closed, { delivery: 'd-2' })).status, 202);
  const replayed = await send(closed, { delivery: 'd-2' });
  assert.equal(replayed.status, 202);
  assert.equal(replayed.data, 'Duplicate');
});

test('errors never leak internals', { skip }, async () => {
  const c = env.client();
  await fullLogin(c, 'root.admin', PASSWORD, superadmin.secret);
  const r = await c.post('/api/admin/db/transactions', { ops: [{ op: 'insert', table: 'findings', values: { review_id: 424242, severity: 'warning' } }] });
  const text = JSON.stringify(r.data);
  assert.ok(!/constraint|violates|findings_review_id|relation|postgres|\bpg\b|stack/i.test(text.replace('Operation 1 (insert findings)', '')), `leaked: ${text}`);
});

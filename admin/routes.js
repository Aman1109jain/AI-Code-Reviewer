'use strict';
const express = require('express');
const QRCode = require('qrcode');
const store = require('../admin/store');
const schemas = require('./schemas');
const limits = require('../middleware/rateLimits');
const { validate, idParam } = require('../middleware/validate');
const { HttpError, wrap } = require('../middleware/errors');
const { loadAdminSession, requireAdmin, setAdminCookie, clearAdminCookie } = require('../middleware/auth');
const { NAMES, readCookie } = require('../lib/cookies');
const { encrypt, decrypt, hmacHex } = require('../lib/crypto');
const pw = require('../lib/password');
const totp = require('../lib/totp');
const { withTransaction } = require('../database/tx');
const dbRoutes = require('./db-routes');

const router = express.Router();
const ISSUER = 'AI Code Reviewer';
const GENERIC_LOGIN_ERROR = 'Invalid username or password, or the account is temporarily locked.';

const meta = (req) => ({ ip: req.ip, userAgent: req.get('user-agent') });
const actor = (req) => ({ adminId: req.admin.id, username: req.admin.username, ip: req.ip });
const publicAdmin = (a) => ({ id: a.id, username: a.username, email: a.email, role: a.role, mfaEnabled: a.mfaEnabled, mustChangePassword: a.mustChangePassword });

function nextStageFor(user) {
  if (user.must_change_password) return 'password_change';
  return user.totp_enabled ? 'mfa_pending' : 'mfa_setup';
}

// Verifies the signed-in admin's own password (step-up for sensitive actions).
async function reauthenticate(req, password) {
  const me = await store.findById(req.admin.id);
  const ok = me && (await pw.verifyPassword(password, me.password_hash));
  if (!ok) {
    await store.recordFailure(req.admin.id).catch(() => {});
    store.auditSafe({ ...actor(req), action: 'reauth.failed' });
    throw new HttpError(403, 'Your current password is incorrect.', { code: 'reauth_failed' });
  }
  return me;
}

function passwordProblems(newPassword, { username, email }) {
  const problems = pw.checkPasswordPolicy(newPassword, { username, email });
  if (problems.length) throw new HttpError(400, problems.join(' '), { details: problems.map((m) => ({ field: 'newPassword', message: m })) });
}

async function startSession(req, res, adminId, stage, replaceSessionId = null) {
  const created = replaceSessionId
    ? await store.rotateSession(replaceSessionId, { adminId, stage, ...meta(req) })
    : await store.createSession({ adminId, stage, ...meta(req) });
  setAdminCookie(req, res, created.token, created.maxAgeMs);
}

router.use(loadAdminSession);

// ---------------------------------------------------------------------------
// Sign-in (public + pending stages)
// ---------------------------------------------------------------------------

router.get('/auth/session', (req, res) => {
  if (!req.admin) return res.json({ authenticated: false });
  return res.json({ authenticated: true, stage: req.admin.stage, admin: publicAdmin(req.admin) });
});

router.post('/auth/login', limits.adminLogin(), validate({ body: schemas.login }), wrap(async (req, res) => {
  const { username, password } = req.body;
  const user = await store.findByUsername(username);
  const eligible = Boolean(user && user.is_active && !store.isLocked(user));

  let ok = false;
  if (eligible) ok = await pw.verifyPassword(password, user.password_hash);
  else await pw.burnTime(password); // same response time whether or not the account exists

  if (!ok) {
    if (eligible) {
      const f = await store.recordFailure(user.id);
      store.auditSafe({ adminId: user.id, username: user.username, action: 'login.failed', ip: req.ip, details: { failedAttempts: f.failed_attempts } });
      if (f.locked_until && new Date(f.locked_until) > new Date()) {
        store.auditSafe({ adminId: user.id, username: user.username, action: 'account.locked', ip: req.ip, details: { until: f.locked_until } });
      }
    } else if (user) {
      store.auditSafe({ adminId: user.id, username: user.username, action: 'login.blocked', ip: req.ip });
    }
    return res.status(401).json({ error: GENERIC_LOGIN_ERROR });
  }

  if (pw.needsRehash(user.password_hash)) {
    store.setPassword(user.id, await pw.hashPassword(password), { mustChange: user.must_change_password }).catch(() => {});
  }
  const stage = nextStageFor(user);
  const previous = readCookie(req, NAMES.adminSession());
  if (previous) await store.destroySessionByToken(previous);
  await startSession(req, res, user.id, stage);
  store.auditSafe({ adminId: user.id, username: user.username, action: 'login.password_ok', ip: req.ip, details: { stage } });
  return res.json({ stage });
}));

router.post('/auth/logout', wrap(async (req, res) => {
  if (req.admin) store.auditSafe({ ...actor(req), action: 'logout' });
  await store.destroySessionByToken(readCookie(req, NAMES.adminSession()));
  clearAdminCookie(req, res);
  res.json({ ok: true });
}));

// First login of an account created by someone else (or after a reset): choose your own password.
router.post('/auth/password/initial', limits.adminMfa(), requireAdmin({ stages: ['password_change'] }), validate({ body: schemas.initialPassword }), wrap(async (req, res) => {
  const me = await reauthenticate(req, req.body.currentPassword);
  passwordProblems(req.body.newPassword, me);
  if (req.body.newPassword === req.body.currentPassword) throw new HttpError(400, 'Choose a different password from the temporary one.');
  await store.setPassword(me.id, await pw.hashPassword(req.body.newPassword), { mustChange: false });
  await store.destroyAllSessions(me.id);
  await startSession(req, res, me.id, me.totp_enabled ? 'mfa_pending' : 'mfa_setup');
  store.auditSafe({ adminId: me.id, username: me.username, action: 'password.changed_initial', ip: req.ip });
  res.json({ stage: me.totp_enabled ? 'mfa_pending' : 'mfa_setup' });
}));

// ---------------------------------------------------------------------------
// Multi-factor authentication (mandatory for every admin)
// ---------------------------------------------------------------------------

router.post('/auth/mfa/setup', limits.adminMfa(), requireAdmin({ stages: ['mfa_setup'] }), wrap(async (req, res) => {
  const secret = totp.generateSecret();
  await store.saveTotpSecret(req.admin.id, encrypt(secret, 'totp'));
  const uri = totp.otpauthUri({ secret, account: req.admin.username, issuer: ISSUER });
  const qr = await QRCode.toDataURL(uri, { margin: 1, width: 220, errorCorrectionLevel: 'M' });
  res.json({ secret, otpauthUri: uri, qr });
}));

async function failMfa(req, res, reason) {
  const attempts = await store.bumpMfaAttempts(req.admin.sessionId);
  await store.recordFailure(req.admin.id).catch(() => {});
  store.auditSafe({ ...actor(req), action: 'mfa.failed', details: { reason } });
  if (attempts >= 5) {
    await store.destroySessionById(req.admin.sessionId);
    clearAdminCookie(req, res);
    return res.status(401).json({ error: 'Too many wrong codes. Please sign in again.', code: 'mfa_session_expired' });
  }
  return res.status(401).json({ error: 'That code is not correct. Check the time on your phone and try the newest code.', code: 'mfa_invalid' });
}

router.post('/auth/mfa/enable', limits.adminMfa(), requireAdmin({ stages: ['mfa_setup'] }), validate({ body: schemas.mfaCode }), wrap(async (req, res) => {
  if (!req.admin.totpSecretEnc) throw new HttpError(400, 'Start the setup first.');
  const secret = decrypt(req.admin.totpSecretEnc, 'totp');
  const check = totp.verifyTotp(secret, req.body.code, { lastUsedStep: null });
  if (!check.ok) return failMfa(req, res, 'enroll_code');

  const codes = totp.generateRecoveryCodes(10);
  const enabled = await store.enableTotp(req.admin.id, check.step, codes.map((c) => hmacHex('recovery', c)));
  if (!enabled) return failMfa(req, res, 'enroll_replay');
  await store.recordLoginSuccess(req.admin.id);
  await startSession(req, res, req.admin.id, 'active', req.admin.sessionId);
  store.auditSafe({ ...actor(req), action: 'mfa.enabled' });
  return res.json({ stage: 'active', recoveryCodes: codes });
}));

router.post('/auth/mfa/verify', limits.adminMfa(), requireAdmin({ stages: ['mfa_pending'] }), validate({ body: schemas.mfaVerify }), wrap(async (req, res) => {
  const { code, recoveryCode } = req.body;
  let okay = false;
  if (code) {
    const secret = decrypt(req.admin.totpSecretEnc, 'totp');
    const check = totp.verifyTotp(secret, code, { lastUsedStep: req.admin.totpLastStep });
    okay = check.ok && (await store.claimTotpStep(req.admin.id, check.step)); // atomic: a code works once
  } else {
    okay = await store.consumeRecoveryCode(req.admin.id, hmacHex('recovery', totp.normalizeRecoveryCode(recoveryCode)));
  }
  if (!okay) return failMfa(req, res, code ? 'code' : 'recovery');

  await store.recordLoginSuccess(req.admin.id);
  await startSession(req, res, req.admin.id, 'active', req.admin.sessionId);
  store.auditSafe({ ...actor(req), action: recoveryCode ? 'login.ok_recovery_code' : 'login.ok' });
  const remaining = await store.countUnusedRecoveryCodes(req.admin.id);
  return res.json({ stage: 'active', recoveryCodesRemaining: remaining });
}));

// ---------------------------------------------------------------------------
// Everything below needs a fully signed-in admin (password + MFA)
// ---------------------------------------------------------------------------

router.use(requireAdmin(), limits.adminAction());

router.get('/me', wrap(async (req, res) => {
  res.json({ admin: publicAdmin(req.admin), recoveryCodesRemaining: await store.countUnusedRecoveryCodes(req.admin.id) });
}));

router.patch('/me', validate({ body: schemas.updateMe }), wrap(async (req, res) => {
  await reauthenticate(req, req.body.currentPassword);
  const { username, email } = req.body;
  const updated = await store.updateProfile(req.admin.id, { username, email });
  store.auditSafe({ ...actor(req), action: 'profile.updated', details: { changed: [username && 'username', email && 'email'].filter(Boolean) } });
  res.json({ admin: { ...publicAdmin(req.admin), username: updated.username, email: updated.email } });
}));

router.post('/me/password', validate({ body: schemas.changePassword }), wrap(async (req, res) => {
  const me = await reauthenticate(req, req.body.currentPassword);
  passwordProblems(req.body.newPassword, me);
  if (req.body.newPassword === req.body.currentPassword) throw new HttpError(400, 'Choose a different password from the current one.');
  await store.setPassword(me.id, await pw.hashPassword(req.body.newPassword));
  await store.destroyAllSessions(me.id, req.admin.sessionId); // sign out every other browser
  await startSession(req, res, me.id, 'active', req.admin.sessionId); // and re-key this one
  store.auditSafe({ ...actor(req), action: 'password.changed' });
  res.json({ ok: true });
}));

router.post('/me/recovery-codes', limits.adminMfa(), validate({ body: schemas.regenCodes }), wrap(async (req, res) => {
  await reauthenticate(req, req.body.currentPassword);
  const secret = decrypt(req.admin.totpSecretEnc, 'totp');
  const check = totp.verifyTotp(secret, req.body.code, { lastUsedStep: req.admin.totpLastStep });
  if (!check.ok || !(await store.claimTotpStep(req.admin.id, check.step))) throw new HttpError(401, 'That code is not correct.', { code: 'mfa_invalid' });
  const codes = totp.generateRecoveryCodes(10);
  await store.replaceRecoveryCodes(req.admin.id, codes.map((c) => hmacHex('recovery', c)));
  store.auditSafe({ ...actor(req), action: 'recovery_codes.regenerated' });
  res.json({ recoveryCodes: codes });
}));

// ---------------------------------------------------------------------------
// Admin accounts
// ---------------------------------------------------------------------------

router.get('/users', wrap(async (req, res) => {
  res.json({ users: await store.listAdmins() });
}));

// Any admin may add another admin. The new account gets a random temporary password
// (shown once); the person must choose their own at first sign-in, then set up MFA.
// Only a superadmin can create another superadmin.
router.post('/users', validate({ body: schemas.createUser }), wrap(async (req, res) => {
  const role = req.body.role === 'superadmin' && req.admin.role === 'superadmin' ? 'superadmin' : 'admin';
  if (req.body.role === 'superadmin' && role !== 'superadmin') throw new HttpError(403, 'Only a superadmin can create a superadmin.', { code: 'forbidden' });
  const temporaryPassword = pw.generateTemporaryPassword();
  const user = await withTransaction(async (client) => {
    const created = await store.createAdmin({
      username: req.body.username, email: req.body.email, role, mustChangePassword: true,
      passwordHash: await pw.hashPassword(temporaryPassword), createdBy: req.admin.id,
    }, client);
    await store.audit({ ...actor(req), action: 'user.created', target: created.username, details: { role } }, client);
    return created;
  });
  res.status(201).json({ user, temporaryPassword });
}));

const superOnly = requireAdmin({ roles: ['superadmin'] });

// Locks the target row (and counts superadmins) inside the transaction so two
// concurrent requests can never leave the system without a superadmin.
async function mutateUser(req, fn) {
  return withTransaction(async (client) => {
    const { rows } = await client.query('SELECT * FROM admin_users WHERE id = $1 FOR UPDATE', [req.params.id]);
    const target = rows[0];
    if (!target) throw new HttpError(404, 'Admin not found.');
    return fn(client, target);
  });
}

async function wouldRemoveLastSuperadmin(client, target) {
  if (target.role !== 'superadmin' || !target.is_active) return false;
  return (await store.countActiveSuperadmins(client)) <= 1;
}

router.patch('/users/:id', superOnly, validate({ params: idParam, body: schemas.updateUser }), wrap(async (req, res) => {
  await reauthenticate(req, req.body.currentPassword);
  const { username, email, role, isActive } = req.body;
  const updated = await mutateUser(req, async (client, target) => {
    if (target.id === req.admin.id && (role !== undefined || isActive !== undefined)) {
      throw new HttpError(400, 'You cannot change your own role or active state. Ask another superadmin.');
    }
    const demoting = role && role !== 'superadmin' && target.role === 'superadmin';
    if ((demoting || isActive === false) && (await wouldRemoveLastSuperadmin(client, target))) {
      throw new HttpError(409, 'That would leave the system without an active superadmin.');
    }
    const { rows } = await client.query(
      `UPDATE admin_users SET username = COALESCE($2, username), email = COALESCE($3, email), role = COALESCE($4, role),
              is_active = COALESCE($5, is_active), updated_at = NOW() WHERE id = $1 RETURNING ${store.PUBLIC_COLUMNS}`,
      [target.id, username || null, email || null, role || null, isActive === undefined ? null : isActive]
    );
    if (isActive === false || (role && role !== target.role)) await store.destroyAllSessions(target.id, null, client);
    await store.audit({ ...actor(req), action: 'user.updated', target: target.username, details: { username: Boolean(username), email: Boolean(email), role: role || undefined, isActive } }, client);
    return rows[0];
  });
  res.json({ user: updated });
}));

router.post('/users/:id/reset-password', superOnly, validate({ params: idParam, body: schemas.reauth }), wrap(async (req, res) => {
  await reauthenticate(req, req.body.currentPassword);
  const temporaryPassword = pw.generateTemporaryPassword();
  const hash = await pw.hashPassword(temporaryPassword);
  const username = await mutateUser(req, async (client, target) => {
    await store.setPassword(target.id, hash, { mustChange: true }, client);
    await store.destroyAllSessions(target.id, null, client);
    await store.audit({ ...actor(req), action: 'user.password_reset', target: target.username }, client);
    return target.username;
  });
  res.json({ username, temporaryPassword });
}));

router.post('/users/:id/reset-mfa', superOnly, validate({ params: idParam, body: schemas.reauth }), wrap(async (req, res) => {
  await reauthenticate(req, req.body.currentPassword);
  await mutateUser(req, async (client, target) => {
    await store.resetMfa(target.id, client);
    await store.destroyAllSessions(target.id, null, client);
    await store.audit({ ...actor(req), action: 'user.mfa_reset', target: target.username }, client);
  });
  res.json({ ok: true });
}));

router.post('/users/:id/unlock', superOnly, validate({ params: idParam }), wrap(async (req, res) => {
  await mutateUser(req, async (client, target) => {
    await client.query('UPDATE admin_users SET failed_attempts = 0, locked_until = NULL WHERE id = $1', [target.id]);
    await store.audit({ ...actor(req), action: 'user.unlocked', target: target.username }, client);
  });
  res.json({ ok: true });
}));

router.delete('/users/:id', superOnly, validate({ params: idParam, body: schemas.reauth }), wrap(async (req, res) => {
  await reauthenticate(req, req.body.currentPassword);
  await mutateUser(req, async (client, target) => {
    if (target.id === req.admin.id) throw new HttpError(400, 'You cannot delete your own account.');
    if (await wouldRemoveLastSuperadmin(client, target)) throw new HttpError(409, 'That would leave the system without an active superadmin.');
    await client.query('DELETE FROM admin_users WHERE id = $1', [target.id]);
    await store.audit({ ...actor(req), action: 'user.deleted', target: target.username }, client);
  });
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// Database console
// ---------------------------------------------------------------------------
router.use('/db', dbRoutes);

module.exports = router;

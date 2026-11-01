'use strict';
const pool = require('../database/connection');
const { withTransaction } = require('../database/tx');
const { getConfig } = require('../config/env');
const { sha256, randomToken } = require('../lib/crypto');

const PENDING_STAGE_MS = 10 * 60 * 1000; // password -> MFA must finish within 10 minutes

const normUsername = (u) => String(u || '').trim().toLowerCase();
const normEmail = (e) => String(e || '').trim().toLowerCase();

const PUBLIC_COLUMNS = `id, username, email, role, is_active, must_change_password, totp_enabled,
                        last_login_at, password_changed_at, created_at, created_by, locked_until`;

// --- accounts ---------------------------------------------------------------

async function findByUsername(username, db = pool) {
  const { rows } = await db.query('SELECT * FROM admin_users WHERE username = $1', [normUsername(username)]);
  return rows[0] || null;
}

async function findById(id, db = pool) {
  const { rows } = await db.query('SELECT * FROM admin_users WHERE id = $1', [id]);
  return rows[0] || null;
}

async function listAdmins() {
  const { rows } = await pool.query(`SELECT ${PUBLIC_COLUMNS} FROM admin_users ORDER BY id`);
  return rows;
}

async function createAdmin({ username, email, passwordHash, role = 'admin', mustChangePassword = false, createdBy = null }, db = pool) {
  const { rows } = await db.query(
    `INSERT INTO admin_users (username, email, password_hash, role, must_change_password, created_by)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${PUBLIC_COLUMNS}`,
    [normUsername(username), normEmail(email), passwordHash, role, mustChangePassword, createdBy]
  );
  return rows[0];
}

async function updateProfile(id, { username, email }, db = pool) {
  const { rows } = await db.query(
    `UPDATE admin_users SET username = COALESCE($2, username), email = COALESCE($3, email), updated_at = NOW()
      WHERE id = $1 RETURNING ${PUBLIC_COLUMNS}`,
    [id, username ? normUsername(username) : null, email ? normEmail(email) : null]
  );
  return rows[0] || null;
}

async function setPassword(id, passwordHash, { mustChange = false } = {}, db = pool) {
  await db.query(
    `UPDATE admin_users SET password_hash = $2, must_change_password = $3, password_changed_at = NOW(),
            failed_attempts = 0, locked_until = NULL, updated_at = NOW() WHERE id = $1`,
    [id, passwordHash, mustChange]
  );
}

// Failed password or MFA attempt. Every 5th failure locks the account for
// 15 min, doubling each further batch of 5 (capped at 24 h).
async function recordFailure(id) {
  const { rows } = await pool.query(
    `UPDATE admin_users
        SET failed_attempts = failed_attempts + 1,
            locked_until = CASE WHEN (failed_attempts + 1) % 5 = 0
              THEN NOW() + LEAST(INTERVAL '24 hours', INTERVAL '15 minutes' * POWER(2, ((failed_attempts + 1) / 5) - 1))
              ELSE locked_until END
      WHERE id = $1 RETURNING failed_attempts, locked_until`,
    [id]
  );
  return rows[0];
}

async function recordLoginSuccess(id) {
  await pool.query('UPDATE admin_users SET failed_attempts = 0, locked_until = NULL, last_login_at = NOW() WHERE id = $1', [id]);
}

const isLocked = (user) => Boolean(user.locked_until && new Date(user.locked_until) > new Date());

async function unlock(id) {
  await pool.query('UPDATE admin_users SET failed_attempts = 0, locked_until = NULL WHERE id = $1', [id]);
}

async function countActiveSuperadmins(db = pool) {
  const { rows } = await db.query(`SELECT COUNT(*)::int AS n FROM admin_users WHERE role = 'superadmin' AND is_active`);
  return rows[0].n;
}

// --- sessions ---------------------------------------------------------------

async function createSession({ adminId, stage, ip, userAgent }, db = pool) {
  const token = randomToken(32);
  const ttl = stage === 'active' ? getConfig().adminMaxMs : PENDING_STAGE_MS;
  await db.query(
    `INSERT INTO admin_sessions (token_hash, admin_id, stage, ip, user_agent, expires_at)
     VALUES ($1, $2, $3, $4, $5, NOW() + ($6::bigint * INTERVAL '1 millisecond'))`,
    [sha256(token), adminId, stage, ip ? String(ip).slice(0, 64) : null, userAgent ? String(userAgent).slice(0, 255) : null, ttl]
  );
  return { token, maxAgeMs: ttl };
}

async function findSession(token) {
  if (!token || typeof token !== 'string' || token.length > 100) return null;
  const { rows } = await pool.query(
    `SELECT s.id AS session_id, s.stage, s.mfa_attempts,
            u.id, u.username, u.email, u.role, u.must_change_password, u.totp_enabled,
            u.totp_secret_enc, u.totp_last_step, u.failed_attempts, u.locked_until
       FROM admin_sessions s JOIN admin_users u ON u.id = s.admin_id
      WHERE s.token_hash = $1
        AND s.expires_at > NOW()
        AND u.is_active
        AND (s.stage <> 'active' OR s.last_seen_at > NOW() - ($2::bigint * INTERVAL '1 millisecond'))`,
    [sha256(token), getConfig().adminIdleMs]
  );
  return rows[0] || null;
}

async function touchSession(sessionId) {
  await pool.query(
    `UPDATE admin_sessions SET last_seen_at = NOW() WHERE id = $1 AND last_seen_at < NOW() - INTERVAL '30 seconds'`,
    [sessionId]
  );
}

async function destroySessionByToken(token) {
  if (token) await pool.query('DELETE FROM admin_sessions WHERE token_hash = $1', [sha256(token)]);
}

async function destroySessionById(sessionId, db = pool) {
  await db.query('DELETE FROM admin_sessions WHERE id = $1', [sessionId]);
}

async function destroyAllSessions(adminId, exceptSessionId = null, db = pool) {
  await db.query('DELETE FROM admin_sessions WHERE admin_id = $1 AND ($2::int IS NULL OR id <> $2)', [adminId, exceptSessionId]);
}

// Every privilege change (password ok -> MFA ok) swaps in a brand-new session id, so a
// pre-login identifier can never become a logged-in one (session-fixation defence).
async function rotateSession(oldSessionId, { adminId, stage, ip, userAgent }) {
  return withTransaction(async (client) => {
    await destroySessionById(oldSessionId, client);
    return createSession({ adminId, stage, ip, userAgent }, client);
  });
}

async function bumpMfaAttempts(sessionId) {
  const { rows } = await pool.query('UPDATE admin_sessions SET mfa_attempts = mfa_attempts + 1 WHERE id = $1 RETURNING mfa_attempts', [sessionId]);
  return rows[0] ? rows[0].mfa_attempts : 99;
}

async function purgeExpired() {
  await pool.query(
    `DELETE FROM admin_sessions WHERE expires_at < NOW()
        OR (stage = 'active' AND last_seen_at < NOW() - ($1::bigint * INTERVAL '1 millisecond'))`,
    [getConfig().adminIdleMs]
  );
}

// --- MFA --------------------------------------------------------------------

async function saveTotpSecret(adminId, encryptedSecret) {
  await pool.query('UPDATE admin_users SET totp_secret_enc = $2, totp_enabled = FALSE, totp_last_step = NULL WHERE id = $1', [adminId, encryptedSecret]);
}

// Atomic replay guard: only succeeds if this time-step is newer than any accepted before.
async function claimTotpStep(adminId, step, db = pool) {
  const { rowCount } = await db.query(
    'UPDATE admin_users SET totp_last_step = $2 WHERE id = $1 AND (totp_last_step IS NULL OR totp_last_step < $2)',
    [adminId, step]
  );
  return rowCount === 1;
}

async function replaceRecoveryCodes(adminId, hashes, db = pool) {
  await db.query('DELETE FROM admin_recovery_codes WHERE admin_id = $1', [adminId]);
  for (const h of hashes) {
    await db.query('INSERT INTO admin_recovery_codes (admin_id, code_hash) VALUES ($1, $2)', [adminId, h]);
  }
}

async function enableTotp(adminId, step, recoveryHashes) {
  return withTransaction(async (client) => {
    const ok = await claimTotpStep(adminId, step, client);
    if (!ok) return false;
    await client.query('UPDATE admin_users SET totp_enabled = TRUE WHERE id = $1', [adminId]);
    await replaceRecoveryCodes(adminId, recoveryHashes, client);
    return true;
  });
}

async function consumeRecoveryCode(adminId, hash) {
  const { rowCount } = await pool.query(
    'UPDATE admin_recovery_codes SET used_at = NOW() WHERE admin_id = $1 AND code_hash = $2 AND used_at IS NULL',
    [adminId, hash]
  );
  return rowCount === 1;
}

async function countUnusedRecoveryCodes(adminId) {
  const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM admin_recovery_codes WHERE admin_id = $1 AND used_at IS NULL', [adminId]);
  return rows[0].n;
}

async function resetMfa(adminId, db = pool) {
  await db.query('UPDATE admin_users SET totp_secret_enc = NULL, totp_enabled = FALSE, totp_last_step = NULL WHERE id = $1', [adminId]);
  await db.query('DELETE FROM admin_recovery_codes WHERE admin_id = $1', [adminId]);
}

// --- audit ------------------------------------------------------------------

// Never put passwords, codes, tokens or secrets in `details`.
async function audit({ adminId = null, username = null, action, target = null, ip = null, details = null }, db = pool) {
  await db.query(
    'INSERT INTO admin_audit_log (admin_id, admin_username, action, target, ip, details) VALUES ($1, $2, $3, $4, $5, $6)',
    [adminId, username, action, target ? String(target).slice(0, 255) : null, ip ? String(ip).slice(0, 64) : null, details ? JSON.stringify(details) : null]
  );
}

// Best-effort variant for events outside a transaction (login attempts etc.).
function auditSafe(entry) {
  return audit(entry).catch((err) => console.error('[audit] failed to record', entry.action, err.message));
}

module.exports = {
  PUBLIC_COLUMNS, normUsername, normEmail,
  findByUsername, findById, listAdmins, createAdmin, updateProfile, setPassword,
  recordFailure, recordLoginSuccess, isLocked, unlock, countActiveSuperadmins,
  createSession, findSession, touchSession, destroySessionByToken, destroySessionById, destroyAllSessions,
  rotateSession, bumpMfaAttempts, purgeExpired,
  saveTotpSecret, claimTotpStep, enableTotp, replaceRecoveryCodes, consumeRecoveryCode, countUnusedRecoveryCodes, resetMfa,
  audit, auditSafe,
};

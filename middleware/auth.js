'use strict';
const { NAMES, readCookie, setCookie, clearCookie } = require('../lib/cookies');
const { resolveGithubAuth } = require('../lib/session');
const adminStore = require('../admin/store');
const { HttpError } = require('./errors');

// --- visitors (GitHub-connected users) --------------------------------------

async function requireGithubUser(req, res, next) {
  try {
    const auth = await resolveGithubAuth(req, res);
    if (!auth) return next(new HttpError(401, 'Connect your GitHub account first.', { code: 'not_connected' }));
    req.ghUser = auth;
    return next();
  } catch (err) {
    return next(err);
  }
}

// --- admins -------------------------------------------------------------------

const ADMIN_COOKIE_OPTS = { sameSite: 'strict' };

function setAdminCookie(req, res, token, maxAgeMs) {
  setCookie(req, res, NAMES.adminSession(), token, { ...ADMIN_COOKIE_OPTS, maxAgeMs });
}

function clearAdminCookie(req, res) {
  clearCookie(req, res, NAMES.adminSession(), ADMIN_COOKIE_OPTS);
}

// Loads the admin session (if any) onto req.admin. Does not reject by itself.
async function loadAdminSession(req, res, next) {
  try {
    const token = readCookie(req, NAMES.adminSession());
    if (token) {
      const row = await adminStore.findSession(token);
      if (row) {
        req.admin = {
          id: row.id, username: row.username, email: row.email, role: row.role,
          stage: row.stage, sessionId: row.session_id, mfaEnabled: row.totp_enabled,
          mustChangePassword: row.must_change_password, mfaAttempts: row.mfa_attempts,
          totpSecretEnc: row.totp_secret_enc, totpLastStep: row.totp_last_step,
        };
        adminStore.touchSession(row.session_id).catch(() => {});
      } else {
        clearAdminCookie(req, res);
      }
    }
    next();
  } catch (err) {
    next(err);
  }
}

// Gate for admin routes. `stages` = which login stages may call it (default: fully
// signed-in only). `roles` restricts further (e.g. ['superadmin']).
function requireAdmin({ stages = ['active'], roles = null } = {}) {
  return async (req, res, next) => {
    if (!req.admin) return next(new HttpError(401, 'Please sign in.', { code: 'admin_auth_required' }));
    if (!stages.includes(req.admin.stage)) {
      return next(new HttpError(403, 'Finish signing in first.', { code: 'admin_stage', stage: req.admin.stage }));
    }
    if (roles && !roles.includes(req.admin.role)) {
      // Recorded before the response is sent, so a refused attempt is never lost.
      await adminStore.auditSafe({
        adminId: req.admin.id, username: req.admin.username, action: 'authz.denied',
        target: `${req.method} ${req.baseUrl}${req.path}`.slice(0, 255), ip: req.ip,
      });
      return next(new HttpError(403, 'You do not have permission to do that.', { code: 'forbidden' }));
    }
    return next();
  };
}

module.exports = { requireGithubUser, loadAdminSession, requireAdmin, setAdminCookie, clearAdminCookie };

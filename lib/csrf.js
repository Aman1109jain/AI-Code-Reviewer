'use strict';
const { getConfig } = require('../config/env');
const { NAMES, readCookie, setCookie } = require('./cookies');
const { randomToken, hmacBase64url, safeEqual } = require('./crypto');

// CSRF protection = three independent layers:
//  1. SameSite cookies (Lax for visitors, Strict for admins)
//  2. Origin / Referer must be this app (see isTrustedOrigin) on every state-changing request
//  3. A per-session token in the X-CSRF-Token header ("signed double-submit cookie"):
//       token = HMAC(server key, csrfCookieSecret | sessionCookies)
//     A cross-site page can neither read the token (CORS blocks the response) nor
//     forge it (needs the server key), and the token changes when anyone logs in or out.

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function bindingFor(req) {
  const sessions = [readCookie(req, NAMES.adminSession()) || '', readCookie(req, NAMES.userSession()) || ''];
  return sessions.join('|');
}

function ensureSecret(req, res) {
  const name = NAMES.csrf();
  let secret = readCookie(req, name);
  if (!secret || !/^[A-Za-z0-9_-]{40,64}$/.test(secret)) {
    secret = randomToken(32);
    setCookie(req, res, name, secret, { sameSite: 'strict' });
    req.cookies = { ...(req.cookies || {}), [name]: secret };
  }
  return secret;
}

function computeToken(secret, binding) {
  return hmacBase64url('csrf', `${secret}|${binding}`);
}

function issueToken(req, res) {
  const secret = ensureSecret(req, res);
  return computeToken(secret, bindingFor(req));
}

// Same-origin check (like Django's): the Origin header must be the app's own
// origin - matched against the Host header - or one listed in ALLOWED_ORIGINS.
function isTrustedOrigin(req) {
  const raw = req.get('origin') || req.get('referer');
  if (!raw) return null; // not a browser form/fetch; the token check still applies
  let origin;
  try {
    origin = new URL(raw).origin;
  } catch {
    return false;
  }
  if (getConfig().allowedOrigins.includes(origin)) return true;
  try {
    return new URL(origin).host === req.get('host');
  } catch {
    return false;
  }
}

function csrfProtection(req, res, next) {
  if (!UNSAFE.has(req.method)) return next();
  const fail = (reason) => res.status(403).json({ error: 'Security check failed. Please reload the page and try again.', code: 'csrf_invalid', reason });

  if (isTrustedOrigin(req) === false) return fail('origin');

  const secret = readCookie(req, NAMES.csrf());
  const header = req.get('x-csrf-token');
  if (!secret || !header) return fail('token_missing');
  if (!safeEqual(header, computeToken(secret, bindingFor(req)))) return fail('token_mismatch');
  return next();
}

module.exports = { csrfProtection, issueToken, isTrustedOrigin, computeToken, UNSAFE };

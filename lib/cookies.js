'use strict';
const { getConfig } = require('../config/env');

// Cookie helpers with secure defaults. In production every cookie is Secure and
// uses the __Host- prefix (which browsers only accept when Secure, Path=/ and no
// Domain is set, so a sibling sub-domain can't overwrite it).

function prefixed(name) {
  return getConfig().isProd ? `__Host-${name}` : name;
}

const NAMES = {
  userSession: () => prefixed('acr_session'),
  adminSession: () => prefixed('acr_admin'),
  csrf: () => prefixed('acr_csrf'),
};

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (!k || Object.prototype.hasOwnProperty.call(out, k)) continue; // first one wins
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      out[k] = v;
    }
  }
  return out;
}

function options(req, { maxAgeMs, sameSite = 'lax' } = {}) {
  const secure = getConfig().isProd || Boolean(req && req.secure);
  const o = { httpOnly: true, secure, sameSite, path: '/' };
  if (maxAgeMs !== undefined) o.maxAge = maxAgeMs;
  return o;
}

function setCookie(req, res, name, value, opts) {
  res.cookie(name, value, options(req, opts));
}

function clearCookie(req, res, name, opts) {
  const { maxAge, ...o } = options(req, opts);
  res.clearCookie(name, o);
}

function readCookie(req, name) {
  return parseCookies(req.headers.cookie)[name];
}

module.exports = { NAMES, parseCookies, setCookie, clearCookie, readCookie };

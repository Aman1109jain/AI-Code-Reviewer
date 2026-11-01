'use strict';
const axios = require('axios');
const pool = require('../database/connection');
const { getConfig } = require('../config/env');
const { encrypt, decrypt, sha256, randomToken } = require('./crypto');
const { NAMES, readCookie, setCookie, clearCookie } = require('./cookies');

// ---------------------------------------------------------------------------
// Per-user GitHub auth.
//
// A visitor clicks "Connect GitHub" and pastes their token once. We keep that token
// encrypted in the database and give their browser a random session id in an
// httpOnly cookie (only its SHA-256 is stored). The expiry slides forward while
// they keep using the app (SESSION_DAYS, default 30) and they can sign out any time.
// ---------------------------------------------------------------------------

const sessionMs = () => getConfig().sessionDays * 24 * 60 * 60 * 1000;
const RENEW_AFTER_MS = 24 * 60 * 60 * 1000; // slide the expiry at most once a day

async function upsertUser({ githubId, login, name, avatarUrl, token }) {
  const { rows } = await pool.query(
    `INSERT INTO github_users (github_id, login, name, avatar_url, access_token_enc)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (github_id) DO UPDATE
       SET login = EXCLUDED.login, name = EXCLUDED.name, avatar_url = EXCLUDED.avatar_url,
           access_token_enc = EXCLUDED.access_token_enc, updated_at = NOW()
     RETURNING id`,
    [githubId, login, name || null, avatarUrl || null, encrypt(token, 'github-token')]
  );
  return rows[0].id;
}

// Always issues a NEW session id (any previous one from this browser is revoked) so a
// pre-login cookie can never be upgraded into a logged-in one.
async function createSession(req, res, userId) {
  const previous = readCookie(req, NAMES.userSession());
  if (previous) await pool.query('DELETE FROM user_sessions WHERE session_hash = $1', [sha256(previous)]);
  const raw = randomToken(32);
  await pool.query(
    `INSERT INTO user_sessions (session_hash, user_id, expires_at)
     VALUES ($1, $2, NOW() + ($3::bigint * INTERVAL '1 millisecond'))`,
    [sha256(raw), userId, sessionMs()]
  );
  setCookie(req, res, NAMES.userSession(), raw, { maxAgeMs: sessionMs() });
}

async function destroySession(req, res) {
  const raw = readCookie(req, NAMES.userSession());
  if (raw) await pool.query('DELETE FROM user_sessions WHERE session_hash = $1', [sha256(raw)]);
  clearCookie(req, res, NAMES.userSession());
}

// Returns { token, userId, login, name, avatarUrl } for the signed-in visitor, or null.
async function resolveGithubAuth(req, res) {
  const raw = readCookie(req, NAMES.userSession());
  if (!raw || raw.length > 100) return null;

  const { rows } = await pool.query(
    `SELECT s.id AS session_id, s.expires_at, u.id AS user_id, u.login, u.name, u.avatar_url, u.access_token_enc
       FROM user_sessions s JOIN github_users u ON u.id = s.user_id
      WHERE s.session_hash = $1 AND s.expires_at > NOW()`,
    [sha256(raw)]
  );
  if (!rows.length) {
    if (res) clearCookie(req, res, NAMES.userSession());
    return null;
  }
  const row = rows[0];

  let token;
  try {
    token = decrypt(row.access_token_enc, 'github-token');
  } catch (err) {
    // SESSION_SECRET changed, or the value is corrupt - treat as signed out.
    console.error('[auth] could not decrypt a stored token:', err.message);
    return null;
  }

  if (new Date(row.expires_at).getTime() - Date.now() < sessionMs() - RENEW_AFTER_MS) {
    pool
      .query(`UPDATE user_sessions SET expires_at = NOW() + ($2::bigint * INTERVAL '1 millisecond') WHERE id = $1`, [row.session_id, sessionMs()])
      .catch(() => {});
    if (res) setCookie(req, res, NAMES.userSession(), raw, { maxAgeMs: sessionMs() });
  }

  return { token, userId: row.user_id, login: row.login, name: row.name, avatarUrl: row.avatar_url };
}

// A stored token that GitHub rejects (revoked) is useless: remove the user so they're
// asked to connect again instead of seeing errors. Sessions cascade.
async function forgetUser(userId) {
  await pool.query('DELETE FROM github_users WHERE id = $1', [userId]);
}

async function purgeExpiredSessions() {
  await pool.query('DELETE FROM user_sessions WHERE expires_at < NOW()');
}

// Webhook deliveries come from GitHub, not a browser, so there is no cookie. Pick a
// connected user whose token can actually see the repo: the repo owner first, then the
// most recently connected others. Returns { token, userId } or null.
// (owner/repo must already be validated by the caller - they go into a URL.)
async function getTokenForRepo(owner, repo) {
  const { rows } = await pool.query(
    `SELECT id, login, access_token_enc FROM github_users
      ORDER BY (LOWER(login) = LOWER($1)) DESC, updated_at DESC
      LIMIT 10`,
    [owner]
  );
  for (const row of rows) {
    let token;
    try {
      token = decrypt(row.access_token_enc, 'github-token');
    } catch {
      continue;
    }
    try {
      await axios.get(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
        timeout: 15000,
      });
      return { token, userId: row.id };
    } catch (err) {
      if (err.response?.status === 401) forgetUser(row.id).catch(() => {});
      // 404 / 403: this user can't see the repo - try the next one.
    }
  }
  return null;
}

module.exports = { upsertUser, createSession, destroySession, resolveGithubAuth, forgetUser, purgeExpiredSessions, getTokenForRepo };

const axios = require('axios');
const pool = require('../database/connection');
const { encrypt, decrypt, sha256, randomToken } = require('./crypto');

// ---------------------------------------------------------------------------
// Per-user GitHub auth.
//
// A visitor clicks "Connect GitHub" once. We keep their OAuth token (encrypted)
// in the database and give their browser a long-lived, httpOnly cookie. On every
// later visit the cookie alone identifies them — no GitHub login needed again,
// until the cookie expires (sliding, 180 days) or they sign out.
// ---------------------------------------------------------------------------

const SESSION_COOKIE = 'acr_session';
const STATE_COOKIE = 'acr_oauth_state';
const SESSION_DAYS = 180;
const SESSION_MS = SESSION_DAYS * 24 * 60 * 60 * 1000;
const RENEW_AFTER_MS = 24 * 60 * 60 * 1000; // slide the expiry at most once a day

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (!k) continue;
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      out[k] = v;
    }
  }
  return out;
}

// Cookie attributes. Same-site setups (the default) use SameSite=Lax. If the
// dashboard and API live on different sites in production, set
// COOKIE_CROSS_SITE=true (requires HTTPS) to use SameSite=None; Secure.
function cookieOptions(maxAgeMs) {
  const cross = process.env.COOKIE_CROSS_SITE === 'true';
  const secure = cross || /^https:/i.test(process.env.GITHUB_CALLBACK_URL || process.env.DASHBOARD_URL || '');
  return { httpOnly: true, secure, sameSite: cross ? 'none' : 'lax', path: '/', maxAge: maxAgeMs };
}

function setCookie(res, name, value, maxAgeMs) {
  res.cookie(name, value, cookieOptions(maxAgeMs));
}

function clearCookie(res, name) {
  const { maxAge, ...opts } = cookieOptions(0);
  res.clearCookie(name, opts);
}

// --- sessions --------------------------------------------------------------

async function upsertUser({ githubId, login, name, avatarUrl, token }) {
  const { rows } = await pool.query(
    `INSERT INTO github_users (github_id, login, name, avatar_url, access_token_enc)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (github_id) DO UPDATE
       SET login = EXCLUDED.login, name = EXCLUDED.name, avatar_url = EXCLUDED.avatar_url,
           access_token_enc = EXCLUDED.access_token_enc, updated_at = NOW()
     RETURNING id`,
    [githubId, login, name || null, avatarUrl || null, encrypt(token)]
  );
  return rows[0].id;
}

async function createSession(res, userId) {
  const raw = randomToken(32);
  await pool.query(
    `INSERT INTO user_sessions (session_hash, user_id, expires_at) VALUES ($1, $2, NOW() + ($3 || ' milliseconds')::interval)`,
    [sha256(raw), userId, String(SESSION_MS)]
  );
  setCookie(res, SESSION_COOKIE, raw, SESSION_MS);
  // Opportunistic cleanup of dead sessions.
  pool.query('DELETE FROM user_sessions WHERE expires_at < NOW()').catch(() => {});
}

async function destroySession(req, res) {
  const raw = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (raw) await pool.query('DELETE FROM user_sessions WHERE session_hash = $1', [sha256(raw)]);
  clearCookie(res, SESSION_COOKIE);
}

// Returns { token, userId, login, name, avatarUrl } for the signed-in visitor,
// or null. Also slides the session expiry forward for active users.
async function resolveGithubAuth(req, res) {
  const raw = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (!raw) return null;

  const { rows } = await pool.query(
    `SELECT s.id AS session_id, s.expires_at, u.id AS user_id, u.login, u.name, u.avatar_url, u.access_token_enc
     FROM user_sessions s JOIN github_users u ON u.id = s.user_id
     WHERE s.session_hash = $1 AND s.expires_at > NOW()`,
    [sha256(raw)]
  );
  if (!rows.length) {
    if (res) clearCookie(res, SESSION_COOKIE);
    return null;
  }
  const row = rows[0];

  let token;
  try {
    token = decrypt(row.access_token_enc);
  } catch (err) {
    // SESSION_SECRET changed, or the value is corrupt — treat as signed out.
    console.error('[auth] could not decrypt stored token:', err.message);
    return null;
  }

  // Sliding expiry: if less than (SESSION_MS - RENEW_AFTER_MS) remains, extend.
  if (new Date(row.expires_at).getTime() - Date.now() < SESSION_MS - RENEW_AFTER_MS) {
    pool
      .query(`UPDATE user_sessions SET expires_at = NOW() + ($2 || ' milliseconds')::interval WHERE id = $1`, [
        row.session_id,
        String(SESSION_MS),
      ])
      .catch(() => {});
    if (res) setCookie(res, SESSION_COOKIE, raw, SESSION_MS);
  }

  return { token, userId: row.user_id, login: row.login, name: row.name, avatarUrl: row.avatar_url };
}

// A stored token that GitHub rejects (revoked / app deauthorised) is useless:
// remove the user so they're asked to connect again instead of seeing errors.
async function forgetUser(userId) {
  await pool.query('DELETE FROM github_users WHERE id = $1', [userId]); // sessions cascade
}

// --- webhooks --------------------------------------------------------------

// Webhook deliveries come from GitHub, not from a browser, so there is no
// cookie. Pick a connected user whose token can actually see the repo: the repo
// owner first (the usual case), then the most recently connected others.
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
      token = decrypt(row.access_token_enc);
    } catch {
      continue;
    }
    try {
      await axios.get(`https://api.github.com/repos/${owner}/${repo}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
      });
      return token;
    } catch (err) {
      if (err.response?.status === 401) forgetUser(row.id).catch(() => {});
      // 404 / 403: this user can't see the repo — try the next one.
    }
  }
  return null;
}

module.exports = {
  SESSION_COOKIE,
  STATE_COOKIE,
  parseCookies,
  setCookie,
  clearCookie,
  upsertUser,
  createSession,
  destroySession,
  resolveGithubAuth,
  forgetUser,
  getTokenForRepo,
};

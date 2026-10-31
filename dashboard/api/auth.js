const express = require('express');
const axios = require('axios');
const router = express.Router();
const { randomToken } = require('../../lib/crypto');
const {
  STATE_COOKIE,
  parseCookies,
  setCookie,
  clearCookie,
  upsertUser,
  createSession,
  destroySession,
} = require('../../lib/session');

// OPTIONAL one-click sign-in. Only used if you register a GitHub OAuth App and set
// GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET in .env. Without them the dashboard's
// "Connect GitHub" dialog uses the paste-your-token route below instead.
//
// OAuth web flow:
//   1. Browser  -> GET  /api/auth/github/login      -> redirect to github.com
//   2. GitHub   -> GET  /api/auth/github/callback   -> we swap the code for a token,
//                                                      store it, set the cookie,
//                                                      send the browser back to the dashboard
// The client id/secret belong to YOUR registered GitHub OAuth App (one-time setup);
// visitors never see or enter any token.

const DASHBOARD_URL = () => (process.env.DASHBOARD_URL || 'http://localhost:5173').replace(/\/+$/, '');
const CALLBACK_URL = () =>
  process.env.GITHUB_CALLBACK_URL || `http://localhost:${process.env.PORT || 3000}/api/auth/github/callback`;

// `repo` is needed to list private repos, read PR diffs, post review comments
// and open PRs from Quick Check. `read:user` identifies who connected.
const SCOPES = 'repo read:user';

// Only allow same-app relative paths ("/review"), never an external URL.
function safeReturnPath(p) {
  return typeof p === 'string' && /^\/(?!\/)[A-Za-z0-9/_\-?=&.%]*$/.test(p) ? p : '/';
}

function backToDashboard(res, query) {
  const qs = query ? `?${new URLSearchParams(query).toString()}` : '';
  res.redirect(`${DASHBOARD_URL()}/${qs}`);
}

router.get('/auth/github/login', (req, res) => {
  const clientId = process.env.GITHUB_CLIENT_ID;
  if (!clientId || !process.env.GITHUB_CLIENT_SECRET) {
    return backToDashboard(res, { github_error: 'not_configured' });
  }
  const state = randomToken(24);
  const returnTo = safeReturnPath(req.query.returnTo);
  // state + return path ride in a short-lived cookie; checked again on callback (CSRF protection).
  setCookie(res, STATE_COOKIE, `${state}|${encodeURIComponent(returnTo)}`, 10 * 60 * 1000);

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: CALLBACK_URL(),
    scope: SCOPES,
    state,
    allow_signup: 'true',
  });
  res.redirect(`https://github.com/login/oauth/authorize?${params.toString()}`);
});

router.get('/auth/github/callback', async (req, res) => {
  const { code, state, error } = req.query;
  const saved = parseCookies(req.headers.cookie)[STATE_COOKIE] || '';
  clearCookie(res, STATE_COOKIE);
  const [savedState, savedReturn] = saved.split('|');
  const returnTo = safeReturnPath(savedReturn ? decodeURIComponent(savedReturn) : '/');

  const fail = (reason) => backToDashboard(res, { github_error: reason });

  if (error) return fail(error === 'access_denied' ? 'access_denied' : 'github_error');
  if (!code || !state || !savedState || state !== savedState) return fail('invalid_state');

  try {
    const tokenRes = await axios.post(
      'https://github.com/login/oauth/access_token',
      {
        client_id: process.env.GITHUB_CLIENT_ID,
        client_secret: process.env.GITHUB_CLIENT_SECRET,
        code,
        redirect_uri: CALLBACK_URL(),
      },
      { headers: { Accept: 'application/json' } }
    );
    const accessToken = tokenRes.data && tokenRes.data.access_token;
    if (!accessToken) {
      console.error('[auth] token exchange failed:', tokenRes.data && tokenRes.data.error);
      return fail('token_exchange_failed');
    }

    const { data: gh } = await axios.get('https://api.github.com/user', {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/vnd.github+json' },
    });

    const userId = await upsertUser({
      githubId: gh.id,
      login: gh.login,
      name: gh.name,
      avatarUrl: gh.avatar_url,
      token: accessToken,
    });
    await createSession(res, userId);

    console.log(`[auth] ${gh.login} connected GitHub`);
    res.redirect(`${DASHBOARD_URL()}${returnTo}`);
  } catch (err) {
    console.error('[auth] callback failed:', err.message);
    fail('server_error');
  }
});

// "Connect GitHub" with no server-side setup: the user pastes their own GitHub
// token in the dashboard. We check it with GitHub, store it encrypted, and give
// the browser the same long-lived cookie as the OAuth route does.
const attempts = new Map(); // ip -> [timestamps]; stops token-guessing
function tooManyAttempts(ip) {
  const now = Date.now();
  const recent = (attempts.get(ip) || []).filter((t) => now - t < 60 * 1000);
  recent.push(now);
  attempts.set(ip, recent);
  return recent.length > 10;
}

router.post('/auth/github/token', async (req, res) => {
  if (tooManyAttempts(req.ip)) {
    return res.status(429).json({ error: 'Too many attempts. Please wait a minute and try again.' });
  }
  const token = String((req.body && req.body.token) || '').trim();
  if (!token || token.length > 400 || /\s/.test(token)) {
    return res.status(400).json({ error: 'Paste a GitHub token (it looks like ghp_… or github_pat_…).' });
  }
  try {
    const { data: gh, headers } = await axios.get('https://api.github.com/user', {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
    });
    const scopes = headers['x-oauth-scopes']; // present for classic tokens only
    if (typeof scopes === 'string' && !scopes.split(',').map((s) => s.trim()).includes('repo')) {
      return res.status(400).json({ error: 'That token is missing the "repo" permission. Create it again with "repo" ticked.' });
    }
    const userId = await upsertUser({
      githubId: gh.id,
      login: gh.login,
      name: gh.name,
      avatarUrl: gh.avatar_url,
      token,
    });
    await createSession(res, userId);
    console.log(`[auth] ${gh.login} connected GitHub (token)`);
    res.json({ ok: true, login: gh.login });
  } catch (err) {
    if (err.response?.status === 401) {
      return res.status(400).json({ error: 'GitHub rejected that token. Check that you copied all of it and that it hasn\'t expired.' });
    }
    console.error('[auth] token connect failed:', err.message);
    res.status(500).json({ error: 'Could not reach GitHub. Please try again.' });
  }
});

router.post('/auth/logout', async (req, res) => {
  try {
    await destroySession(req, res);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

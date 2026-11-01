'use strict';
const express = require('express');
const axios = require('axios');
const { z } = require('zod');
const router = express.Router();
const limits = require('../../middleware/rateLimits');
const { validate } = require('../../middleware/validate');
const { HttpError, wrap } = require('../../middleware/errors');
const { upsertUser, createSession, destroySession } = require('../../lib/session');

// "Connect GitHub": the visitor pastes their own GitHub token. We verify it with
// GitHub, keep it encrypted, and give the browser a session cookie.
// (The optional OAuth-app flow was removed: it needed extra secrets and redirect
// handling that this deployment never used, and unused auth code is attack surface.)

const tokenBody = z.strictObject({
  token: z.string().trim().min(20, 'That does not look like a GitHub token.').max(400).regex(/^[A-Za-z0-9_]+$/, 'That does not look like a GitHub token.'),
});

router.post('/auth/github/token', limits.githubToken(), validate({ body: tokenBody }), wrap(async (req, res) => {
  const { token } = req.body;
  try {
    const { data: gh, headers } = await axios.get('https://api.github.com/user', {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
      timeout: 15000,
    });
    const scopes = headers['x-oauth-scopes']; // present for classic tokens only
    if (typeof scopes === 'string' && !scopes.split(',').map((s) => s.trim()).includes('repo')) {
      throw new HttpError(400, 'That token is missing the "repo" permission. Create it again with "repo" ticked.');
    }
    const userId = await upsertUser({ githubId: gh.id, login: gh.login, name: gh.name, avatarUrl: gh.avatar_url, token });
    await createSession(req, res, userId);
    console.log(`[auth] ${gh.login} connected GitHub`);
    res.json({ ok: true, login: gh.login });
  } catch (err) {
    if (err instanceof HttpError) throw err;
    if (err.response?.status === 401) {
      throw new HttpError(400, "GitHub rejected that token. Check that you copied all of it and that it hasn't expired.");
    }
    console.error('[auth] token connect failed:', err.message);
    throw new HttpError(502, 'Could not reach GitHub. Please try again.');
  }
}));

router.post('/auth/logout', wrap(async (req, res) => {
  await destroySession(req, res);
  res.json({ ok: true });
}));

module.exports = router;

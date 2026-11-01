'use strict';
const express = require('express');
const axios = require('axios');
const router = express.Router();
const { resolveGithubAuth, forgetUser } = require('../../lib/session');
const { requireGithubUser } = require('../../middleware/auth');
const { HttpError, wrap } = require('../../middleware/errors');

// Whether this browser is connected, and as whom. Served from our own database.
router.get('/github/status', wrap(async (req, res) => {
  let auth = null;
  try {
    auth = await resolveGithubAuth(req, res);
  } catch (err) {
    console.error('[github/status]', err.message);
    return res.json({ connected: false, reason: 'Could not check your GitHub connection.' });
  }
  if (!auth) return res.json({ connected: false });
  return res.json({
    connected: true,
    login: auth.login,
    name: auth.name,
    avatarUrl: auth.avatarUrl,
    profileUrl: `https://github.com/${encodeURIComponent(auth.login)}`,
  });
}));

router.get('/github/repos', requireGithubUser, wrap(async (req, res) => {
  try {
    const { data } = await axios.get('https://api.github.com/user/repos', {
      headers: { Authorization: `Bearer ${req.ghUser.token}`, Accept: 'application/vnd.github+json' },
      params: { sort: 'updated', per_page: 100, affiliation: 'owner,collaborator,organization_member' },
      timeout: 20000,
    });
    res.json(
      data.map((r) => ({
        id: r.id, name: r.name, fullName: r.full_name, owner: r.owner?.login, private: r.private,
        description: r.description, htmlUrl: r.html_url, language: r.language, stars: r.stargazers_count,
        updatedAt: r.updated_at, defaultBranch: r.default_branch,
      }))
    );
  } catch (err) {
    if (err.response?.status === 401) {
      // GitHub says the token was revoked: drop it so the user is asked to reconnect.
      await forgetUser(req.ghUser.userId).catch(() => {});
      throw new HttpError(401, 'Your GitHub connection expired. Please connect again.', { code: 'not_connected' });
    }
    console.error('[github/repos]', err.message);
    throw new HttpError(502, 'Could not load your repositories from GitHub.');
  }
}));

module.exports = router;

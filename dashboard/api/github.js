const express = require('express');
const axios = require('axios');
const router = express.Router();
const { resolveGithubAuth, forgetUser } = require('../../lib/session');

function githubClient(token) {
  return axios.create({
    baseURL: 'https://api.github.com',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
    },
  });
}

// Whether this browser is connected, and as whom. `oauthConfigured` lets the UI
// tell the site owner (not visitors) when the GitHub OAuth app isn't set up yet.
router.get('/github/status', async (req, res) => {
  const oauthConfigured = Boolean(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET);
  try {
    const auth = await resolveGithubAuth(req, res);
    if (!auth) return res.json({ connected: false, oauthConfigured });
    // Served from our own database — no GitHub round trip on every page load.
    res.json({
      connected: true,
      oauthConfigured,
      login: auth.login,
      name: auth.name,
      avatarUrl: auth.avatarUrl,
      profileUrl: `https://github.com/${auth.login}`,
    });
  } catch (err) {
    console.error('[github/status]', err.message);
    res.json({ connected: false, oauthConfigured, reason: 'Could not check your GitHub connection.' });
  }
});

router.get('/github/repos', async (req, res) => {
  let auth;
  try {
    auth = await resolveGithubAuth(req, res);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
  if (!auth) {
    return res.status(401).json({ error: 'Connect your GitHub account first.' });
  }
  try {
    const { data } = await githubClient(auth.token).get('/user/repos', {
      params: { sort: 'updated', per_page: 100, affiliation: 'owner,collaborator,organization_member' },
    });
    const repos = data.map((r) => ({
      id: r.id,
      name: r.name,
      fullName: r.full_name,
      owner: r.owner?.login,
      private: r.private,
      description: r.description,
      htmlUrl: r.html_url,
      language: r.language,
      stars: r.stargazers_count,
      updatedAt: r.updated_at,
      defaultBranch: r.default_branch,
    }));
    res.json(repos);
  } catch (err) {
    if (err.response?.status === 401) {
      // GitHub says the token was revoked: drop it so the user is asked to reconnect.
      await forgetUser(auth.userId).catch(() => {});
      return res.status(401).json({ error: 'Your GitHub connection expired. Please connect again.' });
    }
    res.status(err.response?.status || 500).json({ error: err.message });
  }
});

module.exports = router;

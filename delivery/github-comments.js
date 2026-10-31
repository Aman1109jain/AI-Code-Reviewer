const axios = require('axios');
const { withRetry } = require('../utils/retry');

async function postComment(owner, repo, pullNumber, commentBody, token) {
  const url = `https://api.github.com/repos/${owner}/${repo}/issues/${pullNumber}/comments`;

  await withRetry(() =>
    axios.post(
      url,
      { body: commentBody },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
        },
      }
    )
  );
}

module.exports = { postComment };
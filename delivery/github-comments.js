'use strict';
const axios = require('axios');
const { withRetry } = require('../utils/retry');

const MAX_COMMENT_CHARS = 60000; // GitHub rejects comments over 65,536 characters

// The comment text contains AI output and code snippets, i.e. untrusted text that
// will be published under the user's name. Defuse @mentions (so a malicious diff
// can't make the bot ping people or teams) and keep it under GitHub's size limit.
function sanitizeComment(text) {
  let out = String(text).replace(/@(?=[A-Za-z0-9])/g, '@\u200b');
  if (out.length > MAX_COMMENT_CHARS) out = `${out.slice(0, MAX_COMMENT_CHARS)}\n\n_(truncated)_`;
  return out;
}

async function postComment(owner, repo, pullNumber, commentBody, token) {
  const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${Number(pullNumber)}/comments`;

  await withRetry(() =>
    axios.post(
      url,
      { body: sanitizeComment(commentBody) },
      {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
        timeout: 30000,
      }
    )
  );
}

module.exports = { postComment, sanitizeComment };

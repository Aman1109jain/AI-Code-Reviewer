'use strict';
const axios = require('axios');

async function fetchDiff(owner, repo, pullNumber, token) {
  const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${Number(pullNumber)}`;

  const response = await axios.get(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github.v3.diff' },
    timeout: 30000,
    maxContentLength: 20 * 1024 * 1024, // a huge diff must not exhaust memory
    responseType: 'text',
    transformResponse: (d) => d,
  });

  return response.data;
}

module.exports = { fetchDiff };

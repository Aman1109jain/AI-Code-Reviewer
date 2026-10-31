const axios = require('axios');

async function fetchDiff(owner, repo, pullNumber, token) {
  const url = `https://api.github.com/repos/${owner}/${repo}/pulls/${pullNumber}`;

  const response = await axios.get(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github.v3.diff',
    },
  });

  return response.data;
}

module.exports = { fetchDiff };

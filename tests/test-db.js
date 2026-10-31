// Run from the project root: node tests/test-db.js
// Confirms the DB connection + findings/db.js functions work, using fake data.
// No real GitHub PR or webhook needed.
require('dotenv').config();
const { createReview, saveFinding, getAllReviews, getFindingsByReview } = require('../findings/db');

async function test() {
  const reviewId = await createReview({
    sourceType: 'github_pr',
    repoOwner: 'testuser',
    repoName: 'test-repo',
    prNumber: 1,
    fileName: null,
  });
  console.log('Created review id:', reviewId);

  await saveFinding(reviewId, {
    filePath: 'app.js',
    severity: 'blocking',
    category: 'security',
    issue: 'Hardcoded API key found',
    suggestion: 'Move the key to an environment variable',
  });

  await saveFinding(reviewId, {
    filePath: 'utils/helpers.js',
    severity: 'nitpick',
    category: 'readability',
    issue: 'Function name is unclear',
    suggestion: 'Rename to something more descriptive',
  });

  const all = await getAllReviews();
  console.log('All reviews:', all);

  const findings = await getFindingsByReview(reviewId);
  console.log('Findings for that review:', findings);

  process.exit(0);
}

test().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});

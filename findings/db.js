'use strict';
const pool = require('../database/connection');

// Every read that serves a visitor is scoped by owner_user_id, so one connected user
// can never see (or guess the id of) another user's reviews. Admins use the separate
// admin console API instead.

// Creates a review and all its findings in ONE transaction: either everything is
// stored or nothing is (no half-saved reviews if the server dies mid-way).
async function createReviewWithFindings(review, findings = []) {
  const {
    sourceType, repoOwner = null, repoName = null, prNumber = null, fileName = null,
    overallScore = null, diffText = null, sourceCode = null, sourceFiles = null, ownerUserId = null,
  } = review;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // JSONB column: arrays must be stringified, otherwise pg sends a Postgres array literal.
    const { rows } = await client.query(
      `INSERT INTO reviews (source_type, repo_owner, repo_name, pr_number, file_name, overall_score,
                            diff_text, source_code, source_files, owner_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
      [sourceType, repoOwner, repoName, prNumber, fileName, overallScore, diffText, sourceCode,
        sourceFiles ? JSON.stringify(sourceFiles) : null, ownerUserId]
    );
    const reviewId = rows[0].id;
    for (const f of findings) {
      await client.query(
        `INSERT INTO findings (review_id, file_path, severity, category, issue, suggestion)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [reviewId, f.filePath, f.severity, f.category, f.issue, f.suggestion]
      );
    }
    await client.query('COMMIT');
    return reviewId;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Review list for the dashboard. The big text columns (diff, source) are deliberately
// NOT selected: they can be hundreds of KB per row and the list never shows them.
async function getReviewsForUser(userId) {
  const { rows } = await pool.query(
    `SELECT r.id, r.source_type, r.repo_owner, r.repo_name, r.pr_number, r.file_name,
            r.overall_score, r.created_at, COUNT(f.id)::int AS finding_count
       FROM reviews r
       LEFT JOIN findings f ON f.review_id = r.id
      WHERE r.owner_user_id = $1
      GROUP BY r.id
      ORDER BY r.created_at DESC
      LIMIT 500`,
    [userId]
  );
  return rows;
}

// One review, only if it belongs to this user (null otherwise - same as "not found").
async function getReviewForUser(reviewId, userId) {
  const { rows } = await pool.query('SELECT * FROM reviews WHERE id = $1 AND owner_user_id = $2', [reviewId, userId]);
  return rows[0] || null;
}

async function getFindingsByReview(reviewId) {
  const { rows } = await pool.query('SELECT * FROM findings WHERE review_id = $1 ORDER BY created_at ASC, id ASC', [reviewId]);
  return rows;
}

async function getFindingCountsBySeverity(userId) {
  const { rows } = await pool.query(
    `SELECT f.severity, COUNT(*)::int AS count
       FROM findings f JOIN reviews r ON r.id = f.review_id
      WHERE r.owner_user_id = $1
      GROUP BY f.severity`,
    [userId]
  );
  return rows;
}

module.exports = {
  createReviewWithFindings,
  getReviewsForUser,
  getReviewForUser,
  getFindingsByReview,
  getFindingCountsBySeverity,
};

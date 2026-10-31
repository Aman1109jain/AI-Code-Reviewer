const pool = require('../database/connection');

// Creates one review row (either a GitHub PR review or an uploaded-file review)
// and returns its new id.
async function createReview({
  sourceType,
  repoOwner,
  repoName,
  prNumber,
  fileName,
  overallScore = null,
  diffText = null,
  sourceCode = null,
  sourceFiles = null,
}) {
  // JSONB column: arrays must be stringified, otherwise pg sends a Postgres
  // array literal instead of JSON.
  const sourceFilesJson = sourceFiles ? JSON.stringify(sourceFiles) : null;
  const result = await pool.query(
    `INSERT INTO reviews (source_type, repo_owner, repo_name, pr_number, file_name, overall_score, diff_text, source_code, source_files)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
    [sourceType, repoOwner, repoName, prNumber, fileName, overallScore, diffText, sourceCode, sourceFilesJson]
  );
  return result.rows[0].id;
}

// Deletes a review and its findings. Findings are removed explicitly first
// so this works even before the ON DELETE CASCADE migration has been run.
async function deleteReview(reviewId) {
  await pool.query('DELETE FROM findings WHERE review_id = $1', [reviewId]);
  const result = await pool.query('DELETE FROM reviews WHERE id = $1 RETURNING id', [reviewId]);
  return result.rows.length > 0;
}

// Saves one finding, linked to a review.
async function saveFinding(reviewId, { filePath, severity, category, issue, suggestion }) {
  await pool.query(
    `INSERT INTO findings (review_id, file_path, severity, category, issue, suggestion)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [reviewId, filePath, severity, category, issue, suggestion]
  );
}

// All reviews, newest first, with a finding count for the list view.
async function getAllReviews() {
  const result = await pool.query(
    `SELECT r.*, COUNT(f.id)::int AS finding_count
     FROM reviews r
     LEFT JOIN findings f ON f.review_id = r.id
     GROUP BY r.id
     ORDER BY r.created_at DESC`
  );
  return result.rows;
}

// One review by id (used by the drilldown route to show repo/PR/file context).
async function getReviewById(reviewId) {
  const result = await pool.query('SELECT * FROM reviews WHERE id = $1', [reviewId]);
  return result.rows[0] || null;
}

// All findings for one review.
async function getFindingsByReview(reviewId) {
  const result = await pool.query(
    'SELECT * FROM findings WHERE review_id = $1 ORDER BY created_at ASC',
    [reviewId]
  );
  return result.rows;
}

// Counts of findings grouped by severity, for the trends chart.
async function getFindingCountsBySeverity() {
  const result = await pool.query(
    `SELECT severity, COUNT(*)::int AS count
     FROM findings
     GROUP BY severity`
  );
  return result.rows;
}

// Whitelisted tables the "Tables" view in the dashboard is allowed to browse.
// Keeping this as an explicit allowlist (rather than querying information_schema
// directly) avoids ever building a query string from client input.
const BROWSABLE_TABLES = {
  // Large text columns are cut short here: uploaded folders can be hundreds of
  // KB per row, and this table view only ever shows a short preview anyway.
  reviews: `SELECT id, source_type, repo_owner, repo_name, pr_number, file_name, overall_score, created_at,
                   LEFT(diff_text, 200) AS diff_text,
                   LEFT(source_code, 200) AS source_code,
                   LEFT(source_files::text, 200) AS source_files
            FROM reviews ORDER BY created_at DESC LIMIT 200`,
  findings: 'SELECT * FROM findings ORDER BY created_at DESC LIMIT 200',
};

function listTableNames() {
  return Object.keys(BROWSABLE_TABLES);
}

async function getTableRows(tableName) {
  const query = BROWSABLE_TABLES[tableName];
  if (!query) return null;
  const result = await pool.query(query);
  return { columns: result.fields.map((f) => f.name), rows: result.rows };
}

module.exports = {
  createReview,
  saveFinding,
  getAllReviews,
  getReviewById,
  getFindingsByReview,
  getFindingCountsBySeverity,
  deleteReview,
  listTableNames,
  getTableRows,
};

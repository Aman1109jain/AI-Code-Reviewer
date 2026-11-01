'use strict';
const express = require('express');
const axios = require('axios');
const { z } = require('zod');
const router = express.Router();
const { analyzeDiff } = require('../../review-engine/llm-analyzer');
const { runStaticAnalysis } = require('../../review-engine/static-analyzer');
const { mergeFindings } = require('../../review-engine/merge-findings');
const { normalizeFindings } = require('../../findings/validate');
const { createReviewWithFindings, getReviewForUser } = require('../../findings/db');
const { reviewEvents } = require('../../lib/events');
const { forgetUser } = require('../../lib/session');
const { requireGithubUser } = require('../../middleware/auth');
const limits = require('../../middleware/rateLimits');
const { validate, idParam } = require('../../middleware/validate');
const { HttpError, wrap } = require('../../middleware/errors');
const Q = require('../../utils/quick-files');

// How many batches go to the AI at the same time. Low on purpose: Gemini's free
// tier rate-limits quickly, and withRetry() already handles brief 503s.
const AI_CONCURRENCY = 3;

const NAME_RE = /^[A-Za-z0-9_.-]{1,100}$/;

// Shape check only - the real file rules (size, type, paths, secrets) live in
// utils/quick-files.js and are applied again on the server.
const reviewBody = z.strictObject({
  code: z.string().optional(),
  fileName: z.string().max(300).optional(),
  files: z.array(z.strictObject({ path: z.string().max(400), content: z.string() })).max(2000).optional(),
});

const optionalText = (max) => z.string().max(max).optional();
const createPrBody = z.strictObject({
  owner: z.string().regex(NAME_RE, 'Invalid repository owner.'),
  repo: z.string().regex(NAME_RE, 'Invalid repository name.'),
  branchName: z.string().max(200),
  baseBranch: optionalText(200),
  targetDir: optionalText(200),
  commitMessage: optionalText(500),
  prTitle: optionalText(256),
  prBody: optionalText(10000),
});

// Reviews one batch of files: static analysis first, then the AI.
// Never throws - a failure is reported back so the user isn't told
// "no issues found" when the AI never actually looked at the code.
async function reviewBatch(batch) {
  const diff = Q.buildSyntheticDiff(batch);

  let staticFindings = [];
  try {
    staticFindings = await runStaticAnalysis(diff);
  } catch (err) {
    console.error('FAILED at runStaticAnalysis (quick review):', err.message);
  }

  let llmFindings = [];
  let aiFailed = false;
  try {
    const out = await analyzeDiff(diff, staticFindings);
    llmFindings = Array.isArray(out) ? out : [];
  } catch (err) {
    aiFailed = true;
    console.error('FAILED at analyzeDiff (quick review):', err.message);
  }

  return { findings: mergeFindings(staticFindings, llmFindings), aiFailed, paths: batch.map((f) => f.path) };
}

// POST /api/quick-review
// Body: either { code, fileName }  (pasted code)
//       or     { files: [{ path, content }, ...] }  (uploaded files / a folder)
router.post('/quick-review', requireGithubUser, limits.quickReview(), validate({ body: reviewBody }), wrap(async (req, res) => {
  const { code, fileName, files } = req.body;

  let inputFiles;
  let skipped = [];
  let isPaste = false;

  if (Array.isArray(files) && files.length) {
    const normalized = Q.normalizeFiles(files);
    inputFiles = normalized.files;
    skipped = normalized.skipped;
    if (!inputFiles.length) throw new HttpError(400, 'None of the uploaded files could be reviewed.', { details: skipped });
  } else if (typeof code === 'string' && code.trim()) {
    isPaste = true;
    const normalized = Q.normalizeFiles([{ path: Q.sanitizePath(fileName) || 'snippet.txt', content: code }]);
    inputFiles = normalized.files;
    skipped = normalized.skipped;
    if (!inputFiles.length) {
      const why = skipped[0] ? skipped[0].reason : 'unsupported input';
      throw new HttpError(400, `This code can't be reviewed: ${why}.`, { details: skipped });
    }
  } else {
    throw new HttpError(400, 'No code provided.');
  }

  const batches = Q.chunkFiles(inputFiles);
  console.log(`[quick-review] ${inputFiles.length} file(s) in ${batches.length} batch(es)`);
  const startedAt = Date.now();

  const results = await Q.mapWithConcurrency(batches, AI_CONCURRENCY, reviewBatch);

  const findings = normalizeFindings(Q.canonicalizeFindings(inputFiles, results.flatMap((r) => r.findings)));
  const failedBatches = results.filter((r) => r.aiFailed);

  // If the AI failed everywhere and nothing else turned anything up, saving a
  // "clean" review would be a lie. Tell the user to retry instead.
  if (failedBatches.length === results.length && findings.length === 0) {
    return res.status(503).json({
      error: "The AI review service didn't respond (it may be busy). Nothing was saved - please try again in a minute.",
      skipped,
    });
  }

  const warnings = [];
  if (failedBatches.length) {
    const missed = failedBatches.flatMap((r) => r.paths);
    const shown = missed.slice(0, 5).join(', ');
    const more = missed.length > 5 ? ` and ${missed.length - 5} more` : '';
    warnings.push(`The AI review didn't complete for ${missed.length} file(s): ${shown}${more}. Static analysis still ran on them - re-run to retry.`);
  }

  const overallScore = Q.computeUploadScore(inputFiles, findings);
  const reviewId = await createReviewWithFindings(
    {
      sourceType: 'quick_check',
      fileName: Q.labelForFiles(inputFiles),
      diffText: Q.buildSyntheticDiff(inputFiles),
      sourceCode: isPaste ? inputFiles[0].content : null,
      sourceFiles: isPaste ? null : inputFiles,
      overallScore,
      ownerUserId: req.ghUser.userId,
    },
    findings
  );

  reviewEvents.emit('change', { type: 'review-created', reviewId, ownerUserId: req.ghUser.userId });
  console.log(`[quick-review] saved review #${reviewId} (${findings.length} finding(s), ${((Date.now() - startedAt) / 1000).toFixed(1)}s)`);

  res.json({
    reviewId, findings, overallScore, fileCount: inputFiles.length,
    files: inputFiles.map((f) => f.path), skipped, warnings,
  });
}));

// POST /api/quick-review/:id/create-pr
// Pushes every file from a Quick Check review to a new branch in ONE commit and
// opens a pull request. Uses the Git Data API (blobs/trees/commits) rather than
// the single-file Contents API, so folders work and the PR has a single commit.
router.post('/quick-review/:id/create-pr', requireGithubUser, limits.createPr(), validate({ params: idParam, body: createPrBody }), wrap(async (req, res) => {
  const auth = req.ghUser;
  const { owner, repo, branchName, commitMessage, prTitle, prBody, baseBranch, targetDir } = req.body;

  if (!branchName || !Q.isValidBranchName(branchName)) {
    throw new HttpError(400, 'Invalid branch name. Use letters, numbers, ".", "_", "-" and "/".');
  }
  if (baseBranch && !Q.isValidBranchName(baseBranch)) throw new HttpError(400, 'Invalid base branch name.');

  let prefix = '';
  if (targetDir && targetDir.trim()) {
    prefix = Q.sanitizePath(targetDir);
    if (!prefix) throw new HttpError(400, 'Invalid folder name.');
  }

  // Only the review's owner may publish its code anywhere.
  const review = await getReviewForUser(req.params.id, auth.userId);
  let filesToPush = null;
  if (review && Array.isArray(review.source_files) && review.source_files.length) {
    filesToPush = review.source_files;
  } else if (review && review.source_code) {
    filesToPush = [{ path: review.file_name || 'snippet.txt', content: review.source_code }];
  }
  if (!filesToPush) throw new HttpError(404, 'Review not found, or it has no stored source code.');

  const entries = [];
  for (const f of filesToPush) {
    const clean = Q.sanitizePath(f.path);
    if (!clean) throw new HttpError(400, `Unsupported file path: ${String(f.path).slice(0, 80)}`);
    entries.push({ path: prefix ? `${prefix}/${clean}` : clean, mode: '100644', type: 'blob', content: f.content });
  }

  const client = axios.create({
    baseURL: 'https://api.github.com',
    headers: { Authorization: `Bearer ${auth.token}`, Accept: 'application/vnd.github+json' },
    timeout: 30000,
  });
  const repoUrl = `/repos/${owner}/${repo}`;

  try {
    const base = baseBranch || (await client.get(repoUrl)).data.default_branch;

    const { data: baseRef } = await client.get(`${repoUrl}/git/ref/heads/${base}`);
    const baseSha = baseRef.object.sha;
    const { data: baseCommit } = await client.get(`${repoUrl}/git/commits/${baseSha}`);

    const { data: tree } = await client.post(`${repoUrl}/git/trees`, { base_tree: baseCommit.tree.sha, tree: entries });

    const label = entries.length === 1 ? entries[0].path : `${entries.length} files`;
    const { data: commit } = await client.post(`${repoUrl}/git/commits`, {
      message: commitMessage || `Add ${label} via AI Code Reviewer`,
      tree: tree.sha,
      parents: [baseSha],
    });

    await client.post(`${repoUrl}/git/refs`, { ref: `refs/heads/${branchName}`, sha: commit.sha });

    const { data: pr } = await client.post(`${repoUrl}/pulls`, {
      title: prTitle || `Add ${label}`,
      body: prBody || 'Opened from the AI Code Reviewer dashboard.',
      head: branchName,
      base,
    });

    res.json({ success: true, prUrl: pr.html_url, prNumber: pr.number, fileCount: entries.length });
  } catch (err) {
    if (err.response?.status === 401) {
      await forgetUser(auth.userId).catch(() => {});
      throw new HttpError(401, 'Your GitHub connection expired. Please connect again.', { code: 'not_connected' });
    }
    const status = err.response?.status;
    if (status && status >= 400 && status < 500 && status !== 429) {
      // GitHub's own explanation ("Reference already exists", "Not Found"...) is safe and useful.
      throw new HttpError(status === 403 || status === 404 || status === 422 ? status : 400, String(err.response.data?.message || 'GitHub rejected the request.').slice(0, 300));
    }
    console.error('[create-pr]', err.message);
    throw new HttpError(502, 'GitHub did not respond. Please try again.');
  }
}));

module.exports = router;

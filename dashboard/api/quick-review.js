const express = require('express');
const axios = require('axios');
const router = express.Router();
const { analyzeDiff } = require('../../review-engine/llm-analyzer');
const { runStaticAnalysis } = require('../../review-engine/static-analyzer');
const { mergeFindings } = require('../../review-engine/merge-findings');
const { createReview, saveFinding, getReviewById } = require('../../findings/db');
const { reviewEvents } = require('../../lib/events');
const { resolveGithubAuth, forgetUser } = require('../../lib/session');
const Q = require('../../utils/quick-files');

// How many batches go to the AI at the same time. Low on purpose: Gemini's free
// tier rate-limits quickly, and withRetry() already handles brief 503s.
const AI_CONCURRENCY = 3;

const NAME_RE = /^[A-Za-z0-9_.-]+$/;

// Reviews one batch of files: static analysis first, then the AI.
// Never throws — a failure is reported back so the user isn't told
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

  return {
    findings: mergeFindings(staticFindings, llmFindings),
    aiFailed,
    paths: batch.map((f) => f.path),
  };
}

// POST /api/quick-review
// Body: either { code, fileName }  (pasted code)
//       or     { files: [{ path, content }, ...] }  (uploaded files / a folder)
router.post('/quick-review', async (req, res) => {
  const { code, fileName, files } = req.body || {};

  let inputFiles;
  let skipped = [];
  let isPaste = false;

  if (Array.isArray(files) && files.length) {
    const normalized = Q.normalizeFiles(files);
    inputFiles = normalized.files;
    skipped = normalized.skipped;
    if (!inputFiles.length) {
      return res.status(400).json({ error: 'None of the uploaded files could be reviewed.', skipped });
    }
  } else if (typeof code === 'string' && code.trim()) {
    isPaste = true;
    const normalized = Q.normalizeFiles([{ path: Q.sanitizePath(fileName) || 'snippet.txt', content: code }]);
    inputFiles = normalized.files;
    skipped = normalized.skipped;
    if (!inputFiles.length) {
      const why = skipped[0] ? skipped[0].reason : 'unsupported input';
      return res.status(400).json({ error: `This code can't be reviewed: ${why}.`, skipped });
    }
  } else {
    return res.status(400).json({ error: 'No code provided.' });
  }

  try {
    const batches = Q.chunkFiles(inputFiles);
    console.log(`[quick-review] ${inputFiles.length} file(s) in ${batches.length} batch(es)`);
    const startedAt = Date.now();

    const results = await Q.mapWithConcurrency(batches, AI_CONCURRENCY, reviewBatch);

    const findings = Q.canonicalizeFindings(inputFiles, results.flatMap((r) => r.findings));
    const failedBatches = results.filter((r) => r.aiFailed);

    // If the AI failed everywhere and nothing else turned anything up, saving a
    // "clean" review would be a lie. Tell the user to retry instead.
    if (failedBatches.length === results.length && findings.length === 0) {
      return res.status(503).json({
        error: "The AI review service didn't respond (it may be busy). Nothing was saved — please try again in a minute.",
        skipped,
      });
    }

    const warnings = [];
    if (failedBatches.length) {
      const missed = failedBatches.flatMap((r) => r.paths);
      const shown = missed.slice(0, 5).join(', ');
      const more = missed.length > 5 ? ` and ${missed.length - 5} more` : '';
      warnings.push(
        `The AI review didn't complete for ${missed.length} file(s): ${shown}${more}. Static analysis still ran on them — re-run to retry.`
      );
    }

    const overallScore = Q.computeUploadScore(inputFiles, findings);

    const reviewId = await createReview({
      sourceType: 'quick_check',
      fileName: Q.labelForFiles(inputFiles),
      diffText: Q.buildSyntheticDiff(inputFiles),
      sourceCode: isPaste ? inputFiles[0].content : null,
      sourceFiles: isPaste ? null : inputFiles,
      overallScore,
    });
    for (const finding of findings) {
      await saveFinding(reviewId, finding);
    }

    reviewEvents.emit('change', { type: 'review-created', reviewId });
    console.log(`[quick-review] saved review #${reviewId} (${findings.length} finding(s), ${((Date.now() - startedAt) / 1000).toFixed(1)}s)`);

    res.json({
      reviewId,
      findings,
      overallScore,
      fileCount: inputFiles.length,
      files: inputFiles.map((f) => f.path),
      skipped,
      warnings,
    });
  } catch (err) {
    console.error('Quick review failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/quick-review/:id/create-pr
// Pushes every file from a Quick Check review to a new branch in ONE commit and
// opens a pull request. Uses the Git Data API (blobs/trees/commits) rather than
// the single-file Contents API, so folders work and the PR has a single commit.
router.post('/quick-review/:id/create-pr', async (req, res) => {
  let auth;
  try {
    auth = await resolveGithubAuth(req, res);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
  if (!auth) return res.status(401).json({ error: 'Connect your GitHub account first.' });

  const { owner, repo, branchName, commitMessage, prTitle, prBody, baseBranch, targetDir } = req.body || {};
  if (!owner || !repo || !branchName) {
    return res.status(400).json({ error: 'owner, repo, and branchName are required.' });
  }
  if (!NAME_RE.test(owner) || !NAME_RE.test(repo)) {
    return res.status(400).json({ error: 'Invalid repository name.' });
  }
  if (!Q.isValidBranchName(branchName)) {
    return res.status(400).json({ error: 'Invalid branch name. Use letters, numbers, ".", "_", "-" and "/".' });
  }
  if (baseBranch && !Q.isValidBranchName(baseBranch)) {
    return res.status(400).json({ error: 'Invalid base branch name.' });
  }

  let prefix = '';
  if (targetDir && String(targetDir).trim()) {
    prefix = Q.sanitizePath(String(targetDir));
    if (!prefix) return res.status(400).json({ error: 'Invalid folder name.' });
  }

  let review;
  try {
    review = await getReviewById(req.params.id);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }

  let filesToPush = null;
  if (review && Array.isArray(review.source_files) && review.source_files.length) {
    filesToPush = review.source_files;
  } else if (review && review.source_code) {
    filesToPush = [{ path: review.file_name || 'snippet.txt', content: review.source_code }];
  }
  if (!filesToPush) {
    return res.status(404).json({ error: 'Review not found, or it has no stored source code.' });
  }

  const entries = [];
  for (const f of filesToPush) {
    const clean = Q.sanitizePath(f.path);
    if (!clean) return res.status(400).json({ error: `Unsupported file path: ${f.path}` });
    entries.push({
      path: prefix ? `${prefix}/${clean}` : clean,
      mode: '100644',
      type: 'blob',
      content: f.content,
    });
  }

  const client = axios.create({
    baseURL: 'https://api.github.com',
    headers: { Authorization: `Bearer ${auth.token}`, Accept: 'application/vnd.github+json' },
  });
  const repoUrl = `/repos/${owner}/${repo}`;

  try {
    const base = baseBranch || (await client.get(repoUrl)).data.default_branch;

    const { data: baseRef } = await client.get(`${repoUrl}/git/ref/heads/${base}`);
    const baseSha = baseRef.object.sha;
    const { data: baseCommit } = await client.get(`${repoUrl}/git/commits/${baseSha}`);

    const { data: tree } = await client.post(`${repoUrl}/git/trees`, {
      base_tree: baseCommit.tree.sha,
      tree: entries,
    });

    const label = entries.length === 1 ? entries[0].path : `${entries.length} files`;
    const { data: commit } = await client.post(`${repoUrl}/git/commits`, {
      message: commitMessage || `Add ${label} via AI Code Reviewer`,
      tree: tree.sha,
      parents: [baseSha],
    });

    await client.post(`${repoUrl}/git/refs`, {
      ref: `refs/heads/${branchName}`,
      sha: commit.sha,
    });

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
      return res.status(401).json({ error: 'Your GitHub connection expired. Please connect again.' });
    }
    res.status(err.response?.status || 500).json({ error: err.response?.data?.message || err.message });
  }
});

module.exports = router;

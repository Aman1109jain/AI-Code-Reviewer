'use strict';
const crypto = require('crypto');
const { z } = require('zod');
const { getConfig } = require('../config/env');
const { fetchDiff } = require('../fetch-prepare/diff-fetcher');
const { analyzeDiff } = require('../review-engine/llm-analyzer');
const { runStaticAnalysis } = require('../review-engine/static-analyzer');
const { mergeFindings, computeOverallScore } = require('../review-engine/merge-findings');
const { normalizeFindings } = require('../findings/validate');
const { postComment } = require('../delivery/github-comments');
const { createReviewWithFindings } = require('../findings/db');
const { reviewEvents } = require('../lib/events');
const { getTokenForRepo } = require('../lib/session');

// ---------------------------------------------------------------------------
// Authenticity: every delivery must carry GitHub's HMAC-SHA256 signature of the exact
// bytes it sent, made with GITHUB_WEBHOOK_SECRET. Anyone else who finds the URL gets 401.
//
// Note on smee.io (development): smee re-serialises the JSON before forwarding it, and
// GitHub escapes < > & as \u003c \u003e \u0026. We therefore also accept the signature
// over the body with those characters re-escaped. This is still a full HMAC check - no
// request without the secret can pass it. In production point GitHub straight at this
// server (no smee) and the first, exact-bytes check is what matches.
// ---------------------------------------------------------------------------

const hmac = (secret, data) => crypto.createHmac('sha256', secret).update(data).digest();

function verifySignature(rawBody, header, secret) {
  if (!secret || !Buffer.isBuffer(rawBody) || typeof header !== 'string' || !header.startsWith('sha256=')) return false;
  const given = Buffer.from(header.slice(7), 'hex');
  if (given.length !== 32) return false;
  const escaped = Buffer.from(
    rawBody.toString('utf8').replace(/[<>&\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`),
    'utf8'
  );
  return [rawBody, escaped].some((candidate) => crypto.timingSafeEqual(hmac(secret, candidate), given));
}

const NAME = z.string().regex(/^[A-Za-z0-9._-]{1,100}$/);
const payloadSchema = z.object({
  action: z.string().max(40),
  repository: z.object({ name: NAME, owner: z.object({ login: NAME }) }),
  pull_request: z.object({ number: z.number().int().min(1).max(1_000_000_000) }),
});

// Replays: GitHub gives every delivery a unique id; remember recent ones.
const recent = new Map();
function seenBefore(id) {
  if (!id) return false;
  const now = Date.now();
  for (const [k, t] of recent) if (now - t > 10 * 60 * 1000) recent.delete(k);
  if (recent.has(id)) return true;
  recent.set(id, now);
  if (recent.size > 1000) recent.delete(recent.keys().next().value);
  return false;
}

// Reviews are slow and expensive (Semgrep + AI): never run more than 2 at once and
// never queue without limit, so a burst of PR events can't exhaust the server.
const MAX_CONCURRENT = 2;
const MAX_QUEUE = 50;
let active = 0;
const queue = [];
function enqueue(job) {
  if (queue.length >= MAX_QUEUE) {
    console.warn('[webhook] review queue is full - dropping a delivery');
    return;
  }
  queue.push(job);
  pump();
}
function pump() {
  while (active < MAX_CONCURRENT && queue.length) {
    const job = queue.shift();
    active += 1;
    job()
      .catch((err) => console.error('Background review error:', err.message))
      .finally(() => {
        active -= 1;
        pump();
      });
  }
}

let warnedNoSecret = false;
function handleWebhook(req, res) {
  const secret = getConfig().webhookSecret;
  if (!secret) {
    if (!warnedNoSecret) {
      warnedNoSecret = true;
      console.error('[webhook] GITHUB_WEBHOOK_SECRET is not set - rejecting all webhooks. Set it in .env and use the same value as the "Secret" in the GitHub webhook settings.');
    }
    return res.status(503).send('Webhook not configured');
  }

  const delivery = String(req.get('x-github-delivery') || '').slice(0, 64);
  if (!verifySignature(req.rawBody, req.get('x-hub-signature-256'), secret)) {
    console.warn(`[webhook] rejected delivery ${delivery || '(no id)'} from ${req.ip}: signature check failed`);
    return res.status(401).send('Invalid signature');
  }

  const eventName = req.get('x-github-event');
  if (eventName === 'ping') return res.status(200).send('pong');
  if (eventName !== 'pull_request') return res.status(202).send('Ignored');
  if (seenBefore(delivery)) return res.status(202).send('Duplicate');

  const parsed = payloadSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).send('Unexpected payload');
  const { action, repository, pull_request: pr } = parsed.data;
  if (action !== 'opened' && action !== 'synchronize') return res.status(202).send('Ignored');

  res.status(202).send('Accepted');
  enqueue(() => processReview({ owner: repository.owner.login, repo: repository.name, pullNumber: pr.number }));
  return undefined;
}

async function processReview({ owner, repo, pullNumber }) {
  // No browser is involved in a webhook, so borrow the token of a connected
  // user who can access this repo (see lib/session.js).
  let access;
  try {
    access = await getTokenForRepo(owner, repo);
  } catch (err) {
    console.error('FAILED looking up a GitHub token:', err.message);
    return;
  }
  if (!access) {
    console.warn(
      `Skipping PR #${pullNumber} in ${owner}/${repo}: no connected GitHub user can access this repo. ` +
        'Open the dashboard and click "Connect GitHub" with an account that has access.'
    );
    return;
  }
  const { token, userId } = access;

  const startTime = Date.now();
  console.log(`Fetching diff for PR #${pullNumber} in ${owner}/${repo}...`);

  let diff;
  try {
    const t0 = Date.now();
    diff = await fetchDiff(owner, repo, pullNumber, token);
    console.log(`--- DIFF FETCHED (${((Date.now() - t0) / 1000).toFixed(1)}s) ---`);
  } catch (err) {
    console.error('FAILED at fetchDiff:', err.message);
    return;
  }
  if (typeof diff !== 'string') {
    console.error('FAILED at fetchDiff: unexpected response');
    return;
  }

  let staticFindings;
  try {
    const t1 = Date.now();
    staticFindings = await runStaticAnalysis(diff);
    console.log(`Static analysis found ${staticFindings.length} issue(s). (${((Date.now() - t1) / 1000).toFixed(1)}s)`);
  } catch (err) {
    console.error('FAILED at runStaticAnalysis:', err.message);
    staticFindings = [];
  }

  let llmFindings;
  try {
    const t2 = Date.now();
    llmFindings = await analyzeDiff(diff, staticFindings);
    console.log(`Gemini review complete. (${((Date.now() - t2) / 1000).toFixed(1)}s)`);
  } catch (err) {
    console.error('FAILED at analyzeDiff:', err.message);
    llmFindings = [];
  }

  const review = normalizeFindings(mergeFindings(staticFindings, llmFindings));
  const overallScore = computeOverallScore(review);

  try {
    const t3 = Date.now();
    const reviewId = await createReviewWithFindings(
      { sourceType: 'github_pr', repoOwner: owner, repoName: repo, prNumber: pullNumber, diffText: diff, overallScore, ownerUserId: userId },
      review
    );
    console.log(`--- SAVED REVIEW #${reviewId} WITH ${review.length} FINDING(S) (${((Date.now() - t3) / 1000).toFixed(1)}s) ---`);
    // Tell the owner's open dashboards a new review exists so they refresh live.
    reviewEvents.emit('change', { type: 'review-created', reviewId, ownerUserId: userId });
  } catch (err) {
    console.error('FAILED at saving review/findings to DB:', err.message);
  }

  try {
    let commentBody;
    if (review.length === 0) {
      commentBody = '**AI Code Review**\n\nNo issues found.';
    } else {
      const formatted = review
        .map((f) => `**File:** ${f.filePath}\n**Severity:** ${f.severity}\n**Category:** ${f.category}\n**Issue:** ${f.issue}\n**Suggestion:** ${f.suggestion}`)
        .join('\n\n---\n\n');
      commentBody = `**AI Code Review**\n\n${formatted}`;
    }
    await postComment(owner, repo, pullNumber, commentBody, token);
    console.log('--- COMMENT POSTED ---');
  } catch (err) {
    console.error('FAILED at postComment:', err.message);
  }

  console.log(`TOTAL TIME: ${((Date.now() - startTime) / 1000).toFixed(1)}s for PR #${pullNumber}`);
}

module.exports = { handleWebhook, verifySignature, processReview };

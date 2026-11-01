'use strict';
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const { getConfig } = require('../config/env');

// In-memory counters: correct for a single server process. If you ever run several
// instances behind a load balancer, switch to a shared store (e.g. rate-limit-redis).
function limiter({ windowMs, limit, message, key, skipSuccessful = false }) {
  const disabled = getConfig().isTest && process.env.RATE_LIMITS !== 'on';
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skipSuccessfulRequests: skipSuccessful,
    skip: () => disabled,
    keyGenerator: key || ((req) => ipKeyGenerator(req.ip)),
    handler: (req, res) => res.status(429).json({ error: message || 'Too many requests. Please slow down and try again shortly.', code: 'rate_limited' }),
  });
}

const minutes = (n) => n * 60 * 1000;
const byUser = (req) => `u:${req.ghUser ? req.ghUser.userId : ipKeyGenerator(req.ip)}`;
const byAdmin = (req) => `a:${req.admin ? req.admin.id : ipKeyGenerator(req.ip)}`;

module.exports = {
  // Everything under /api.
  api: () => limiter({ windowMs: minutes(15), limit: 600 }),
  // Password step of the admin login: 10 tries / 15 min / IP (plus per-account lockout in the database).
  adminLogin: () => limiter({ windowMs: minutes(15), limit: 10, message: 'Too many sign-in attempts. Try again in a few minutes.' }),
  // Second factor + other pre-login admin steps.
  adminMfa: () => limiter({ windowMs: minutes(15), limit: 15, message: 'Too many attempts. Try again in a few minutes.' }),
  // Everything an admin does once signed in.
  adminAction: () => limiter({ windowMs: minutes(5), limit: 200, key: byAdmin }),
  // "Paste your GitHub token" - stops token guessing.
  githubToken: () => limiter({ windowMs: minutes(15), limit: 10, message: 'Too many attempts. Please wait a few minutes and try again.' }),
  // Each Quick Check costs an AI call: cap per connected user.
  quickReview: () => limiter({ windowMs: minutes(60), limit: 20, key: byUser, message: 'Quick Check limit reached (20 per hour). Please try again later.' }),
  createPr: () => limiter({ windowMs: minutes(60), limit: 30, key: byUser }),
  csrfToken: () => limiter({ windowMs: minutes(1), limit: 60 }),
  webhook: () => limiter({ windowMs: minutes(1), limit: 120 }),
};

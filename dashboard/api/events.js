'use strict';
const express = require('express');
const router = express.Router();
const { reviewEvents } = require('../../lib/events');
const { requireGithubUser } = require('../../middleware/auth');

const MAX_PER_USER = 5;
const MAX_TOTAL = 500;
const openPerUser = new Map();
let openTotal = 0;

// Server-sent events: pushes "something changed" pings so open dashboards refresh.
// Only the owner's own events are forwarded; the payload carries ids, never content.
router.get('/events', requireGithubUser, (req, res) => {
  const userId = req.ghUser.userId;
  const count = openPerUser.get(userId) || 0;
  if (count >= MAX_PER_USER || openTotal >= MAX_TOTAL) {
    return res.status(429).json({ error: 'Too many open dashboard tabs.' });
  }
  openPerUser.set(userId, count + 1);
  openTotal += 1;

  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders?.();

  const send = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
  send({ type: 'connected' });

  const onChange = (payload) => {
    if (payload.ownerUserId !== undefined && payload.ownerUserId !== userId) return;
    send({ type: payload.type, reviewId: payload.reviewId });
  };
  reviewEvents.on('change', onChange);
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 25000);

  let closed = false;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    reviewEvents.off('change', onChange);
    openTotal -= 1;
    const left = (openPerUser.get(userId) || 1) - 1;
    if (left <= 0) openPerUser.delete(userId);
    else openPerUser.set(userId, left);
  };
  req.on('close', cleanup);
  res.on('error', cleanup);
  return undefined;
});

module.exports = router;

const express = require('express');
const router = express.Router();
const { reviewEvents } = require('../../lib/events');

router.get('/events', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.flushHeaders?.();

  const send = (payload) => {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  send({ type: 'connected' });

  const onChange = (payload) => send(payload);
  reviewEvents.on('change', onChange);

  const heartbeat = setInterval(() => res.write(': ping\n\n'), 25000);

  req.on('close', () => {
    clearInterval(heartbeat);
    reviewEvents.off('change', onChange);
  });
});

module.exports = router;

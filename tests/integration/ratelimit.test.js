'use strict';
process.env.RATE_LIMITS = 'on'; // limits are normally disabled in tests; this file runs in its own process
const { skip, start } = require('../helpers/harness');
const test = require('node:test');
const assert = require('node:assert/strict');

let env;
test.before(async () => { if (!skip) env = await start(); });
test.after(async () => { if (env) await env.stop(); });

test('admin login is rate limited per IP (10 attempts / 15 min)', { skip }, async () => {
  const c = env.client();
  const statuses = [];
  for (let i = 0; i < 12; i += 1) statuses.push((await c.post('/api/admin/auth/login', { username: 'ghost', password: 'wrong-password-1' })).status);
  assert.deepEqual(statuses.slice(0, 10), Array(10).fill(401));
  assert.deepEqual(statuses.slice(10), [429, 429]);
  const blocked = await c.post('/api/admin/auth/login', { username: 'ghost', password: 'wrong-password-1' });
  assert.equal(blocked.data.code, 'rate_limited');
  assert.ok(blocked.headers.get('ratelimit') || blocked.headers.get('ratelimit-policy'), 'standard RateLimit headers are sent');
});

test('GitHub token connect is rate limited too (token guessing)', { skip }, async () => {
  const c = env.client();
  const statuses = [];
  for (let i = 0; i < 12; i += 1) statuses.push((await c.post('/api/auth/github/token', { token: 'short' })).status);
  assert.equal(statuses.filter((s) => s === 429).length, 2);
});

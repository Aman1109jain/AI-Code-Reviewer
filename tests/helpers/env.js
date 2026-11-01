'use strict';
// Every test file starts with: require('../helpers/env');
// It points the app at a harmless test configuration and makes sure a real .env can
// never leak in: dotenv is never loaded by the tests, and the real database URL is
// ignored unless TEST_DATABASE_URL is set explicitly.
process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'unit-test-secret-0123456789-abcdefghijklmnop';
process.env.DASHBOARD_URL = 'http://localhost:5173';
process.env.GITHUB_WEBHOOK_SECRET = 'webhook-test-secret-123456';
delete process.env.SMEE_URL;
if (process.env.TEST_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.DATABASE_SSL = process.env.TEST_DATABASE_SSL || 'off';
} else {
  delete process.env.DATABASE_URL;
}

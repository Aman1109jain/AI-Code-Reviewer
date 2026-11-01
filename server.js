'use strict';
require('dotenv').config({ quiet: true });

let config;
try {
  config = require('./config/env').getConfig();
} catch (err) {
  console.error(`\n${err.message}\n`);
  process.exit(1);
}
if (!config.databaseUrl) {
  console.error('\nInvalid configuration:\n  - DATABASE_URL is required.\n');
  process.exit(1);
}
config.warnings.forEach((w) => console.warn(`[config] ${w}`));

const { createApp } = require('./app');
const pool = require('./database/connection');
const adminStore = require('./admin/store');
const { purgeExpiredSessions } = require('./lib/session');

const app = createApp();
const PORT = config.port;

const server = app.listen(PORT, (err) => {
  // Express 5 hands startup failures (e.g. the port is taken) to this callback.
  if (err) {
    if (err.code === 'EADDRINUSE') {
      console.error(
        `\nPort ${PORT} is already in use by another program, so the API could not start.\n` +
          `Close that program, or change PORT in .env.\n` +
          `Windows: run  netstat -ano | findstr :${PORT}  to find the process.\n`
      );
    } else {
      console.error('Server failed to start:', err.message);
    }
    process.exit(1);
  }
  console.log(`Server is running on http://localhost:${PORT} (${config.nodeEnv})`);
});
server.keepAliveTimeout = 65000;

// Housekeeping: expired visitor + admin sessions.
const cleanup = setInterval(() => {
  purgeExpiredSessions().catch(() => {});
  adminStore.purgeExpired().catch(() => {});
}, 30 * 60 * 1000);
cleanup.unref();

// ---------------------------------------------------------------------------
// Embedded smee.io client (development only) - forwards GitHub webhook deliveries
// from the smee channel into this process. It is never started in production:
// there, point the GitHub webhook straight at https://your-domain<WEBHOOK_PATH>.
// ---------------------------------------------------------------------------
let smeeEvents = null;
if (config.smeeUrl && !config.isProd) {
  const SmeeClient = require('smee-client').default;
  const client = new SmeeClient({
    source: config.smeeUrl,
    target: `http://localhost:${PORT}${config.webhookPath}`,
    logger: { info: (msg) => console.log(`[smee] ${msg}`), error: (msg) => console.error(`[smee] ${msg}`) },
  });
  smeeEvents = client.start();
  console.log(`[smee] forwarding ${config.smeeUrl} -> http://localhost:${PORT}${config.webhookPath}`);
} else if (config.smeeUrl && config.isProd) {
  console.warn('[smee] SMEE_URL is ignored in production.');
} else {
  console.log('[smee] SMEE_URL not set - skipping embedded webhook forwarding.');
}

let shuttingDown = false;
function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('\nShutting down...');
  if (smeeEvents && typeof smeeEvents.close === 'function') smeeEvents.close();
  server.close(() => pool.end().finally(() => process.exit(code)));
  server.closeAllConnections?.(); // SSE streams would otherwise keep the server open
  setTimeout(() => process.exit(code), 3000).unref();
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
process.on('unhandledRejection', (reason) => console.error('[unhandledRejection]', reason instanceof Error ? reason.stack : reason));
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err.stack || err);
  shutdown(1);
});

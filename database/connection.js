'use strict';
const { Pool } = require('pg');
const { getConfig } = require('../config/env');

// One shared connection pool, reused everywhere else in the app.
// TLS: certificates are verified by default (DATABASE_SSL=verify). Neon's certificates
// chain to a public CA, so this works out of the box. Use DATABASE_SSL=off only for a
// local database, and no-verify only as a last resort.
let pool = null;

function sslOption(mode) {
  if (mode === 'off') return false;
  return { rejectUnauthorized: mode === 'verify' };
}

function getPool() {
  if (pool) return pool;
  const config = getConfig();
  if (!config.databaseUrl) throw new Error('DATABASE_URL is not set.');
  pool = new Pool({
    connectionString: config.databaseUrl,
    ssl: sslOption(config.databaseSsl),
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
    statement_timeout: 30000, // a runaway query can't hold a connection forever
    application_name: 'ai-code-reviewer',
  });
  pool.on('error', (err) => {
    // Idle client errors shouldn't crash the whole server.
    console.error('Unexpected Postgres pool error:', err.message);
  });
  return pool;
}

// Keep the old `require('../database/connection')` call style working:
// the export behaves like a Pool (query / connect / end) but is created lazily.
module.exports = {
  query: (...args) => getPool().query(...args),
  connect: (...args) => getPool().connect(...args),
  end: async () => {
    if (pool) {
      const p = pool;
      pool = null;
      await p.end();
    }
  },
};

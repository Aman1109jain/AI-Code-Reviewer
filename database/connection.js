const { Pool } = require('pg');

// One shared connection pool, reused everywhere else in the app.
// Neon requires SSL; rejectUnauthorized:false is fine for their managed certs.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

pool.on('error', (err) => {
  // Idle client errors shouldn't crash the whole server.
  console.error('Unexpected Postgres pool error:', err.message);
});

module.exports = pool;

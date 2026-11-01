'use strict';
const pool = require('./connection');

// Runs fn(client) inside BEGIN ... COMMIT. Any throw rolls everything back and is
// re-thrown. Retries a couple of times on serialization failures / deadlocks.
async function withTransaction(fn, { isolation = null, retries = 2 } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    const client = await pool.connect();
    try {
      await client.query(isolation ? `BEGIN ISOLATION LEVEL ${isolation}` : 'BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      if ((err.code === '40001' || err.code === '40P01') && attempt < retries) continue;
      throw err;
    } finally {
      client.release();
    }
  }
}

module.exports = { withTransaction };

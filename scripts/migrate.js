'use strict';
require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const pool = require('../database/connection');

// Applies database/migrations/*.sql in order, each one inside a transaction, and
// remembers what has run in the schema_migrations table - so re-running is a no-op
// instead of re-executing (and sometimes failing on) every old file.
//
// Databases created by the previous runner (no schema_migrations table yet) are
// "baselined": migrations 001-006 are recorded as already applied.
const BASELINE_THROUGH = '006';
const dir = path.join(__dirname, '..', 'database', 'migrations');

const checksum = (sql) => crypto.createHash('sha256').update(sql).digest('hex');

async function migrate({ log = console.log } = {}) {
  const client = await pool.connect();
  try {
    // Serialise concurrent runners (two deploys at once).
    await client.query('SELECT pg_advisory_lock(727274)');
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version VARCHAR(10) PRIMARY KEY, name TEXT NOT NULL, checksum CHAR(64) NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);

    const files = fs.readdirSync(dir).filter((f) => /^\d{3}_.+\.sql$/.test(f)).sort();
    const { rows: applied } = await client.query('SELECT version, checksum FROM schema_migrations');
    const done = new Map(applied.map((r) => [r.version, r.checksum]));

    if (done.size === 0) {
      const { rows } = await client.query(`SELECT to_regclass('public.reviews') AS t`);
      if (rows[0].t) {
        for (const f of files.filter((x) => x.slice(0, 3) <= BASELINE_THROUGH)) {
          const sql = fs.readFileSync(path.join(dir, f), 'utf8');
          await client.query('INSERT INTO schema_migrations (version, name, checksum) VALUES ($1,$2,$3)', [f.slice(0, 3), f, checksum(sql)]);
          done.set(f.slice(0, 3), checksum(sql));
          log(`Baseline: ${f} was already applied by the previous runner`);
        }
      }
    }

    let ran = 0;
    for (const f of files) {
      const version = f.slice(0, 3);
      const sql = fs.readFileSync(path.join(dir, f), 'utf8');
      if (done.has(version)) {
        if (done.get(version) !== checksum(sql)) {
          log(`  warning: ${f} was edited after it was applied (migrations should never be changed once applied)`);
        }
        continue;
      }
      log(`Applying ${f}...`);
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (version, name, checksum) VALUES ($1,$2,$3)', [version, f, checksum(sql)]);
        await client.query('COMMIT');
        ran += 1;
        log('  ok');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw new Error(`${f} failed: ${err.message}`);
      }
    }
    log(ran ? `Migrations complete (${ran} applied).` : 'Database is up to date.');
  } finally {
    await client.query('SELECT pg_advisory_unlock(727274)').catch(() => {});
    client.release();
  }
}

module.exports = { migrate };

if (require.main === module) {
  migrate()
    .then(() => pool.end())
    .catch(async (err) => {
      console.error('Migration failed:', err.message);
      await pool.end().catch(() => {});
      process.exit(1);
    });
}

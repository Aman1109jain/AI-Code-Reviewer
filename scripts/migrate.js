require('dotenv').config();
const fs = require('fs');
const path = require('path');
const pool = require('../database/connection');

async function migrate() {
  const dir = path.join(__dirname, '..', 'database', 'migrations');
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    console.log(`Applying ${file}...`);
    try {
      await pool.query(sql);
      console.log(`  ok`);
    } catch (err) {
      // 001_init.sql will fail with "already exists" on a DB that's already
      // been set up once — that's fine, just move on.
      if (err.message.includes('already exists')) {
        console.log(`  skipped (already applied)`);
      } else {
        throw err;
      }
    }
  }

  console.log('Migrations complete.');
  await pool.end();
}

migrate().catch((err) => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});

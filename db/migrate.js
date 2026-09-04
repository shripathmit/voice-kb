'use strict';

/** Applies db/schema.sql. Idempotent — run it as often as you like. */

const fs = require('node:fs');
const path = require('node:path');

const { pool, describeTarget } = require('../lib/db');

async function main() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');

  console.log(`[migrate] target: ${describeTarget()}`);
  await pool.query(sql);
  console.log('[migrate] schema applied');

  const { rows } = await pool.query(`
    SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' ORDER BY table_name
  `);
  console.log(`[migrate] tables: ${rows.map((r) => r.table_name).join(', ')}`);
}

main()
  .catch((err) => {
    console.error(`[migrate] failed: ${err.message}`);
    process.exitCode = 1;
  })
  .finally(() => pool.end());

'use strict';

/**
 * CLI wrapper around lib/seed.js.
 *
 * Re-running upserts by entry id, so editing kb/knowledge-base.json and
 * re-seeding is a safe way to bulk-edit. It will not delete entries you added
 * directly in SQL unless you pass --replace.
 */

const path = require('node:path');

const { pool, describeTarget } = require('../lib/db');
const { seed } = require('../lib/seed');

async function main() {
  const replace = process.argv.includes('--replace');

  console.log(`[seed] target: ${describeTarget()}`);

  const result = await seed({ replace });

  console.log(`[seed] source: ${path.relative(process.cwd(), result.source)}`);
  if (result.removed) console.log(`[seed] --replace removed ${result.removed} entries not in the JSON`);
  console.log(`[seed] done — ${result.entries} active entries, ${result.intros} intro entry`);
}

main()
  .catch((err) => {
    console.error(`[seed] failed: ${err.message}`);
    process.exitCode = 1;
  })
  .finally(() => pool.end());

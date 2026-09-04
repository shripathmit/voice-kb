'use strict';

/**
 * Prints the questions people asked that the knowledge base could not answer,
 * most-asked first. This is the to-do list of answers still worth writing.
 */

const { pool, gaps, stats, placeholders } = require('../lib/db');

async function main() {
  const [rows, summary, stillFiller] = await Promise.all([gaps(50), stats(), placeholders()]);

  console.log(
    `\n${summary.entries} entries · ${summary.questions_asked} questions asked · ${summary.unanswered} unanswered\n`,
  );

  if (stillFiller.length) {
    console.log(`Entries still holding placeholder text (${stillFiller.length}):\n`);
    for (const row of stillFiller) console.log(`  ${row.id}  ${row.question}`);
    console.log('');
  }

  if (rows.length === 0) {
    console.log('Nothing unanswered yet.\n');
    return;
  }

  console.log('Asked but not answered:\n');
  const width = Math.max(...rows.map((r) => r.question.length));
  for (const row of rows) {
    const when = new Date(row.last_asked).toISOString().slice(0, 16).replace('T', ' ');
    console.log(`  ${String(row.times_asked).padStart(3)}×  ${row.question.padEnd(width)}  ${when}`);
  }
  console.log('');
}

main()
  .catch((err) => {
    console.error(`[gaps] failed: ${err.message}`);
    process.exitCode = 1;
  })
  .finally(() => pool.end());

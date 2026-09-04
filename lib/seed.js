'use strict';

/**
 * Loads kb/knowledge-base.json into Postgres.
 *
 * Shared by the `npm run seed` CLI and by the server's first boot. A fresh
 * environment — a new Railway project, a colleague's laptop — has an empty
 * database and no way to reach it from outside, so the app provisions itself
 * from the JSON that ships in the image rather than needing a manual step.
 */

const fs = require('node:fs');
const path = require('node:path');

const { pool } = require('./db');

const SOURCE = path.join(__dirname, '..', 'kb', 'knowledge-base.json');

/** True when the database has no subject row, i.e. has never been seeded. */
async function isEmpty() {
  const { rows } = await pool.query('SELECT 1 FROM subject WHERE id = 1');
  return rows.length === 0;
}

/**
 * @param {{replace?: boolean, source?: string}} options
 *   `replace` also deletes entries that are no longer in the JSON.
 */
async function seed({ replace = false, source = SOURCE } = {}) {
  const data = JSON.parse(fs.readFileSync(source, 'utf8'));
  const subject = data.subject || {};

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(
      `INSERT INTO subject (id, name, short_name, aliases, greeting, sub_greeting, fallback, starters, placeholder)
       VALUES (1, $1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (id) DO UPDATE SET
         name         = EXCLUDED.name,
         short_name   = EXCLUDED.short_name,
         aliases      = EXCLUDED.aliases,
         greeting     = EXCLUDED.greeting,
         sub_greeting = EXCLUDED.sub_greeting,
         fallback     = EXCLUDED.fallback,
         starters     = EXCLUDED.starters,
         placeholder  = EXCLUDED.placeholder`,
      [
        subject.name || 'me',
        subject.shortName || subject.name || 'me',
        subject.aliases || [],
        data.greeting || 'Ask me anything.',
        data.subGreeting || null,
        data.fallback || "That's not something I've covered yet.",
        data.starters || [],
        data.placeholder !== false,
      ],
    );

    let removed = 0;
    if (replace) {
      const ids = data.entries.map((e) => e.id);
      ({ rowCount: removed } = await client.query(
        'DELETE FROM entries WHERE NOT (id = ANY($1::text[]))',
        [ids],
      ));
    }

    // Clear the intro flag first: the partial unique index allows only one, and
    // moving it between entries would otherwise collide mid-transaction.
    await client.query('UPDATE entries SET is_intro = false WHERE is_intro');

    let position = 0;
    for (const entry of data.entries) {
      position += 10;
      await client.query(
        `INSERT INTO entries (id, question, answer, detail, patterns, keywords, tags, is_intro, is_placeholder, position)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (id) DO UPDATE SET
           question       = EXCLUDED.question,
           answer         = EXCLUDED.answer,
           detail         = EXCLUDED.detail,
           patterns       = EXCLUDED.patterns,
           keywords       = EXCLUDED.keywords,
           tags           = EXCLUDED.tags,
           is_intro       = EXCLUDED.is_intro,
           is_placeholder = EXCLUDED.is_placeholder,
           position       = EXCLUDED.position,
           is_active      = true`,
        [
          entry.id,
          entry.question,
          entry.answer,
          entry.detail || null,
          entry.patterns || [],
          entry.keywords || [],
          entry.tags || [],
          Boolean(entry.intro),
          Boolean(entry.placeholder),
          position,
        ],
      );
    }

    await client.query('COMMIT');

    const { rows } = await client.query(
      'SELECT count(*)::int AS entries, count(*) FILTER (WHERE is_intro)::int AS intros FROM entries WHERE is_active',
    );

    return { entries: rows[0].entries, intros: rows[0].intros, removed, source };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { seed, isEmpty, SOURCE };

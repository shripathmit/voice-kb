'use strict';

// Before anything reads process.env.
require('./env').load();

const { Pool } = require('pg');

/**
 * Postgres access layer.
 *
 * One connection string drives everything: locally it points at a Postgres on
 * this machine, on Railway it is the DATABASE_URL that Railway injects. Nothing
 * else about the app changes between the two.
 */

const DEFAULT_LOCAL_URL = `postgres://${process.env.USER || 'postgres'}@localhost:5432/voice_kb`;

function connectionString() {
  return process.env.DATABASE_URL || DEFAULT_LOCAL_URL;
}

/**
 * Three cases:
 *   - localhost: no TLS.
 *   - *.railway.internal: Railway's private network, no TLS terminator in front
 *     of Postgres. Asking for SSL here fails the connection.
 *   - anything else (Railway's public proxy, Neon, RDS): TLS with a cert this
 *     client has no way to verify, so verification is off but transport is not.
 * PGSSLMODE=disable|require overrides all of it.
 */
function sslConfig(url) {
  if (process.env.PGSSLMODE === 'disable') return false;
  if (process.env.PGSSLMODE === 'require') return { rejectUnauthorized: false };

  let host = '';
  try {
    host = new URL(url).hostname;
  } catch {
    return false;
  }

  if (['localhost', '127.0.0.1', '::1', ''].includes(host)) return false;
  if (host.endsWith('.railway.internal')) return false;
  return { rejectUnauthorized: false };
}

const url = connectionString();

const pool = new Pool({
  connectionString: url,
  ssl: sslConfig(url),
  max: Number(process.env.PGPOOL_MAX) || 5,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

pool.on('error', (err) => {
  console.error('[db] idle client error:', err.message);
});

/** Where we are pointed, with the password redacted for logging. */
function describeTarget() {
  try {
    const parsed = new URL(url);
    return `${parsed.username ? `${parsed.username}@` : ''}${parsed.hostname}:${parsed.port || 5432}${parsed.pathname}`;
  } catch {
    return 'unparseable DATABASE_URL';
  }
}

/**
 * Read the whole knowledge base. It is small — a person's worth of answers —
 * so it is loaded whole and indexed in memory rather than queried per request.
 */
async function loadKnowledgeBase() {
  const [subjectRows, entryRows] = await Promise.all([
    pool.query('SELECT * FROM subject WHERE id = 1'),
    pool.query(`
      SELECT id, question, answer, detail, patterns, keywords, tags, is_intro, is_placeholder
        FROM entries
       WHERE is_active
       ORDER BY position, id
    `),
  ]);

  const subject = subjectRows.rows[0];
  if (!subject) {
    throw new Error('No subject row found. Run `npm run seed` to populate the database.');
  }

  return {
    name: `${subject.name} — personal knowledge base`,
    placeholder: subject.placeholder,
    greeting: subject.greeting,
    subGreeting: subject.sub_greeting,
    fallback: subject.fallback,
    starters: subject.starters,
    subject: {
      name: subject.name,
      shortName: subject.short_name,
      aliases: subject.aliases,
    },
    entries: entryRows.rows.map((row) => ({
      id: row.id,
      question: row.question,
      answer: row.answer,
      detail: row.detail,
      patterns: row.patterns,
      keywords: row.keywords,
      tags: row.tags,
      intro: row.is_intro,
      placeholder: row.is_placeholder,
    })),
  };
}

/**
 * Record what was asked. Fire and forget: a logging failure must never cost
 * the visitor their answer.
 */
function logQuery({ raw, question, matched, entryId, confidence, via }) {
  pool
    .query(
      `INSERT INTO queries (raw, question, matched, entry_id, confidence, via)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [raw || null, question, matched, entryId || null, confidence ?? null, via || null],
    )
    .catch((err) => console.error('[db] could not log query:', err.message));
}

/**
 * Questions the knowledge base could not answer, most-asked first. This is the
 * list of answers still worth writing.
 */
async function gaps(limit = 50) {
  const { rows } = await pool.query(
    `SELECT lower(question) AS question,
            count(*)::int   AS times_asked,
            max(asked_at)   AS last_asked
       FROM queries
      WHERE NOT matched
      GROUP BY lower(question)
      ORDER BY times_asked DESC, last_asked DESC
      LIMIT $1`,
    [limit],
  );
  return rows;
}

/** Cached speech for this exact provider/voice/model/text, or null. Bumps the use counter. */
async function getCachedAudio(hash) {
  const { rows } = await pool.query(
    `UPDATE tts_cache
        SET uses = uses + 1, last_used_at = now()
      WHERE hash = $1
      RETURNING audio, alignment, char_count, provider, voice_id, model_id, mime_type`,
    [hash],
  );
  return rows[0] || null;
}

async function putCachedAudio({ hash, provider, voiceId, modelId, mimeType, text, audio, alignment }) {
  await pool.query(
    `INSERT INTO tts_cache (hash, provider, voice_id, model_id, mime_type, text, audio, alignment, char_count)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (hash) DO NOTHING`,
    [
      hash,
      provider || 'unknown',
      voiceId,
      modelId,
      mimeType || 'audio/mpeg',
      text,
      audio,
      alignment ? JSON.stringify(alignment) : null,
      text.length,
    ],
  );
}

/**
 * A version stamp for the knowledge base.
 *
 * Folded into the answer cache key so that editing an entry invalidates every
 * cached answer at once — otherwise a corrected fact would keep being spoken
 * from cache long after it was fixed.
 */
async function knowledgeBaseVersion() {
  const { rows } = await pool.query(
    `SELECT coalesce(max(updated_at), 'epoch')::text AS version, count(*)::int AS n
       FROM entries WHERE is_active`,
  );
  return `${rows[0].version}|${rows[0].n}`;
}

async function getCachedAnswer(hash) {
  const { rows } = await pool.query(
    `UPDATE answer_cache
        SET uses = uses + 1, last_used_at = now()
      WHERE hash = $1
      RETURNING question, answer, entry_ids, matched, model`,
    [hash],
  );
  return rows[0] || null;
}

async function putCachedAnswer({ hash, question, answer, entryIds, matched, model }) {
  await pool.query(
    `INSERT INTO answer_cache (hash, question, answer, entry_ids, matched, model)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (hash) DO NOTHING`,
    [hash, question, answer, entryIds || [], matched !== false, model || null],
  );
}

async function ttsCacheStats() {
  const { rows } = await pool.query(`
    SELECT count(*)::int                      AS clips,
           coalesce(sum(char_count), 0)::int  AS characters_synthesised,
           coalesce(sum(uses - 1), 0)::int    AS characters_saved_plays,
           coalesce(pg_size_pretty(sum(octet_length(audio))), '0 bytes') AS audio_size
      FROM tts_cache
  `);
  return rows[0];
}

/** Entries still holding filler — the list of answers still to write. */
async function placeholders() {
  const { rows } = await pool.query(
    'SELECT id, question FROM entries WHERE is_active AND is_placeholder ORDER BY position',
  );
  return rows;
}

async function stats() {
  const { rows } = await pool.query(`
    SELECT (SELECT count(*)::int FROM entries WHERE is_active)   AS entries,
           (SELECT count(*)::int FROM queries)                   AS questions_asked,
           (SELECT count(*)::int FROM queries WHERE NOT matched) AS unanswered
  `);
  return rows[0];
}

async function ping() {
  await pool.query('SELECT 1');
}

module.exports = {
  pool,
  loadKnowledgeBase,
  logQuery,
  gaps,
  placeholders,
  stats,
  getCachedAudio,
  putCachedAudio,
  ttsCacheStats,
  knowledgeBaseVersion,
  getCachedAnswer,
  putCachedAnswer,
  ping,
  describeTarget,
  connectionString,
};

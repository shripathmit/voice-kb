-- Schema for the personal knowledge base.
-- Idempotent: safe to run against an existing database.

-- ---------------------------------------------------------------------------
-- Who the agent speaks as. Exactly one row, enforced by the check constraint.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS subject (
  id           smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  name         text        NOT NULL,
  short_name   text,
  aliases      text[]      NOT NULL DEFAULT '{}',
  greeting     text        NOT NULL,
  sub_greeting text,
  fallback     text        NOT NULL,
  starters     text[]      NOT NULL DEFAULT '{}',
  placeholder  boolean     NOT NULL DEFAULT true,
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- The answers themselves.
--   patterns — literal phrases that route straight to this entry
--   keywords — topic words used by the scoring pass
-- ---------------------------------------------------------------------------
-- `answer` is what gets spoken, so it stays short — a couple of minutes of
-- monologue does not work out loud. `detail` holds the full written version,
-- shown on screen for anyone who wants the whole thing.
CREATE TABLE IF NOT EXISTS entries (
  id             text PRIMARY KEY,
  question       text        NOT NULL,
  answer         text        NOT NULL,
  detail         text,
  patterns       text[]      NOT NULL DEFAULT '{}',
  keywords       text[]      NOT NULL DEFAULT '{}',
  tags           text[]      NOT NULL DEFAULT '{}',
  is_intro       boolean     NOT NULL DEFAULT false,
  is_active      boolean     NOT NULL DEFAULT true,
  is_placeholder boolean     NOT NULL DEFAULT false,
  position       integer     NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- Added after the table shipped; harmless when they already exist.
ALTER TABLE entries ADD COLUMN IF NOT EXISTS detail text;
ALTER TABLE entries ADD COLUMN IF NOT EXISTS is_placeholder boolean NOT NULL DEFAULT false;

-- A question that names only the subject routes to the intro entry, so there
-- must be exactly one of them.
CREATE UNIQUE INDEX IF NOT EXISTS entries_single_intro
  ON entries ((true)) WHERE is_intro;

CREATE INDEX IF NOT EXISTS entries_active_position
  ON entries (position) WHERE is_active;

-- ---------------------------------------------------------------------------
-- Every question asked. The point of keeping this: the unmatched rows are a
-- to-do list of answers the knowledge base is still missing.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS queries (
  id         bigserial PRIMARY KEY,
  raw        text,
  question   text        NOT NULL,
  matched    boolean     NOT NULL,
  entry_id   text        REFERENCES entries (id) ON DELETE SET NULL,
  confidence real,
  via        text,
  asked_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS queries_unmatched
  ON queries (asked_at DESC) WHERE NOT matched;

CREATE INDEX IF NOT EXISTS queries_asked_at
  ON queries (asked_at DESC);

-- ---------------------------------------------------------------------------
-- Generated speech, kept so the same answer is never paid for twice.
--
-- In Postgres rather than on disk deliberately: Railway containers have an
-- ephemeral filesystem, so a disk cache would be thrown away on every deploy
-- and the whole knowledge base would be re-synthesised at cost.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tts_cache (
  hash         text PRIMARY KEY,          -- sha256(provider | voice | model | text)
  voice_id     text        NOT NULL,
  model_id     text        NOT NULL,
  text         text        NOT NULL,
  audio        bytea       NOT NULL,
  alignment    jsonb,                     -- character-level timings, when returned
  char_count   integer     NOT NULL,
  uses         integer     NOT NULL DEFAULT 1,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS tts_cache_last_used ON tts_cache (last_used_at DESC);

-- Added when Gemini joined ElevenLabs as a provider. Two engines produce
-- different audio for identical text, so the provider belongs in the cache key;
-- the column exists so rows stay legible and can be cleared per provider.
ALTER TABLE tts_cache ADD COLUMN IF NOT EXISTS provider text NOT NULL DEFAULT 'elevenlabs';
ALTER TABLE tts_cache ADD COLUMN IF NOT EXISTS mime_type text NOT NULL DEFAULT 'audio/mpeg';

-- ---------------------------------------------------------------------------
-- Generated answers.
--
-- Once an LLM writes the answer instead of returning a stored row, the same
-- question costs a generation AND a synthesis every time it is asked, and the
-- audio cache stops helping because the wording varies between runs. Caching
-- the answer text makes a repeated question free and instant, and restores the
-- audio cache's hit rate by making the text stable.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS answer_cache (
  hash         text PRIMARY KEY,          -- sha256(kb_version | normalised question)
  question     text        NOT NULL,
  answer       text        NOT NULL,
  entry_ids    text[]      NOT NULL DEFAULT '{}',
  matched      boolean     NOT NULL DEFAULT true,
  model        text,
  uses         integer     NOT NULL DEFAULT 1,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS answer_cache_last_used ON answer_cache (last_used_at DESC);

-- Keep updated_at honest without doing it in application code.
CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS entries_touch ON entries;
CREATE TRIGGER entries_touch BEFORE UPDATE ON entries
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

DROP TRIGGER IF EXISTS subject_touch ON subject;
CREATE TRIGGER subject_touch BEFORE UPDATE ON subject
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

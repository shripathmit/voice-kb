# Ask Shridhar

A voice agent that stands in for one person. Anyone can walk up, ask a question
out loud, and get an answer in that person's voice — spoken, and typed on screen
in time with the audio. One screen, no login, no chat history to scroll.

The knowledge base is what the agent knows about its subject. Right now every
answer is placeholder text; the structure is the part that's real.

Node 18+, Postgres, and one dependency (`pg`).

## Run

First time — create the database, apply the schema, load the starter content:

```bash
createdb voice_kb && npm install && npm run setup
```

Then:

```bash
npm start
```

Open http://localhost:5178. Set `PORT` to change the port.

`npm run setup` is `migrate` then `seed`. Both are idempotent and safe to re-run.

Chrome, Edge, or Safari — voice input uses the Web Speech API. Firefox has no
speech recognition, so the app falls back to a text input on its own.

Add `?debug=1` to the URL to see which entry matched, how, and how confident it
was. Useful while tuning the knowledge base; hidden from whoever is asking.

## How a turn works

1. `public/app.js` starts `SpeechRecognition` and shows the interim transcript live.
2. On pause, `public/parse.js` strips fillers ("um", "you know"), wake prefixes
   ("hey", "can you tell me"), and restarts ("how much how much" → "how much").
   The screen shows what the person said; the stripped form is what gets sent.
3. The cleaned question is POSTed to `/api/ask`.
4. `lib/retrieve.js` finds the best entry, or returns the fallback line.
5. The answer is spoken with `speechSynthesis`; `boundary` events pull the
   typewriter forward so the text tracks the voice instead of drifting.

## Retrieval

Answering questions *about a person* breaks generic FAQ search in two specific
ways, and `lib/retrieve.js` handles both:

**The subject is in every question and means nothing.** "What do *you* do",
"where did *he* study", "tell me about *Shridhar*" — those tokens are stripped
before scoring. A question that is *only* the subject ("tell me about Shridhar")
routes to the entry flagged `"intro": true`.

**The most common questions are too short to score.** "What do you do" is
entirely stopwords; nothing survives tokenising. So entries carry `patterns` —
phrases matched literally, before any scoring. Longest pattern wins, which is
why "what do you do for fun" reaches the hobbies entry instead of the work one.

Anything that clears neither gets the fallback line rather than a weak guess.
Confidence floor is `CONFIDENCE_FLOOR` at the top of the file.

## The database

Postgres, three tables:

| Table | What's in it |
| --- | --- |
| `subject` | One row. Who the agent speaks as: name, aliases, greeting, fallback line, starter questions. |
| `entries` | The answers, with their `patterns`, `keywords`, and `tags`. |
| `queries` | Every question asked, whether it matched, and which entry answered it. |

`queries` is the one that earns its keep. The rows where `matched = false` are a
list of things people wanted to know and the agent couldn't answer:

```bash
npm run gaps
```

```
12 entries · 6 questions asked · 3 unanswered

    2×  do you play chess?           2026-08-15 01:54
    1×  what is your favorite food?  2026-08-15 01:54
```

Same data over HTTP at `/api/gaps`.

The knowledge base is small, so the server reads it whole and indexes it in
memory, re-reading every `KB_CACHE_MS` (default 30s). Edit a row in SQL and the
change appears within that window — or immediately:

```bash
curl -X POST localhost:5178/api/reload
```

If the database goes away mid-run, the server keeps serving the last good copy
and logs the failure rather than going dark.

## Filling in the knowledge base

**The database is the source of truth.** `kb/knowledge-base.json` is the
authoring format for the initial content and the input to `npm run seed`; once
seeded, edit Postgres.

Either edit the JSON and re-seed (upserts by `id`; add `--replace` to also delete
entries no longer in the file), or write SQL directly:

```sql
UPDATE entries
   SET answer = 'The real answer, spoken.', is_placeholder = false
 WHERE id = 'kb-009';

INSERT INTO entries (id, question, answer, detail, patterns, keywords, tags, position)
VALUES ('kb-028', 'What are you reading?',
        'Mostly nonfiction, and whatever the book I am writing sends me toward.',
        NULL,
        ARRAY['what are you reading', 'what books', 'reading list'],
        ARRAY['read', 'reading', 'book', 'books'],
        ARRAY['personal'], 280);
```

### Two answers per entry

`answer` is spoken. `detail` is not — it renders on screen behind a "Read the
full story" toggle. That split exists because a written STAR story runs 300–400
words, which is two and a half minutes of talking; nobody listens that long to a
machine. Write the spoken version as what you'd actually say out loud, and let
`detail` carry the full thing for anyone who wants to read it.

Roughly: 60–150 words spoken is 25–55 seconds, which is the ceiling for a single
voice turn. `detail` can be as long as it needs to be.

Notes that matter when you write the real answers:

- **First person.** The agent is speaking as the subject, not about them.
- **Written to be heard.** Spell numbers out — "twenty percent", not "20%";
  "four point seven out of five", not "4.7/5". No bullets, no URLs, no
  parentheticals; they sound wrong read aloud. `detail` has no such constraint.
- **Set `"placeholder": true`** on any entry still holding filler. `npm run gaps`
  lists them, so nothing invented quietly becomes permanent.
- **`patterns` for phrasing, `keywords` for topic.** Patterns catch the exact way
  people ask; keywords catch everything else that's on the same subject.
- `subject.aliases` is how the agent knows which words refer to it. Add nicknames.
- Set `"placeholder": false` at the top level once the answers are real — that's
  what drives the "placeholder answers" badge in the header.

When retrieval becomes something other than keyword scoring — Postgres
full-text, embeddings in pgvector, an LLM reading these rows as context —
replace `KnowledgeBase.answer()`. The frontend only needs this shape back:

```json
{ "answer": "...", "matched": true, "confidence": 0.82, "via": "pattern",
  "source": { "id": "kb-002" } }
```

## Answers

With `GEMINI_API_KEY` set, answers are **generated** — the model reads the
knowledge base and phrases a reply to the actual question asked. Without it,
answers are **stored**: keyword retrieval returns the entry text verbatim. Both
work; the app never hard-depends on the model.

Generation is **strictly grounded**. The system instruction permits rephrasing,
condensing and merging entries, and forbids introducing any fact not present in
them. Uncovered questions get the fallback line rather than an invention. This
agent speaks in the first person as a real person, to strangers — a fabricated
employer or school would be asserted as fact in his voice.

Entries flagged `is_placeholder` are **withheld from the model entirely**. They
hold filler nobody has replaced yet, and handing invented text to something told
to answer confidently is the most direct route to a false claim. Withheld, those
questions reach the fallback, which is the honest answer.

Keyword retrieval still runs on every question even when the model is doing the
talking: it supplies the source entry, its long-form `detail` for the "read the
full story" toggle, and the entry id recorded in the gap log.

Generated answers are cached in `answer_cache`, keyed on the question plus a
knowledge-base version stamp — so a repeated question costs nothing, and editing
any entry retires every cached answer at once.

## The voice

Three options, in order of preference:

- **Gemini** (`GEMINI_API_KEY`) — 30 prebuilt voices, no cloning.
- **ElevenLabs** (`TTS_PROVIDER=elevenlabs`) — the route to a *cloned* voice, the
  one thing Gemini cannot do. Also the only provider returning character timings.
- **The browser's own `speechSynthesis`** — the fallback. Free, works offline,
  sounds like a robot.

The client never talks to either API and never sees a key. It asks this server
for audio, and if anything goes wrong — no key, no credit, network down — it
drops to the browser voice mid-answer and the listener still gets their answer.

**Picking a male voice requires listening.** Gemini documents its voices only by
manner ("Charon — informative", "Orus — firm"), never by gender:

```bash
node tools/voice-samples.js
```

That writes a WAV per candidate. Play them, then set `GEMINI_TTS_VOICE`.

Gemini returns **raw PCM at 24kHz**, not a playable file. The WAV header is added
server-side at synthesis, so the cache holds directly-servable bytes.

**Audio is cached in Postgres**, keyed on `sha256(provider | voice | model | text)`.
The provider is in the key because two engines produce different audio for the
same words — without it, switching engines would keep serving the old voice and
look like the change hadn't taken. It's in the database rather than on disk
because Railway's filesystem is ephemeral.

**`/api/speak` only speaks text this server produced.** `/api/ask` returns a
`speechToken` — an HMAC over the exact answer text — and `/api/speak` verifies it
before spending anything. Without that, a public URL is an open proxy to a
metered API. (This replaced an earlier check against knowledge-base membership,
which stopped working once a model started writing the answers.)

## Deploying to Railway

1. Create the project and add a **Postgres** service.
2. Add the app service from this repo. `railway.json` sets the start command to
   `npm run migrate && npm start`, so the schema is applied on every deploy —
   it's idempotent, so that's safe.
3. Set variables on the app service:

   | Variable | Value |
   | --- | --- |
   | `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` — the reference, not a pasted string |
   | `ADMIN_TOKEN` | `openssl rand -hex 32` |
   | `ELEVENLABS_API_KEY` | your key, if you want the real voice |
   | `ELEVENLABS_VOICE_ID` | your cloned voice id |

   Don't set `PORT` — Railway provides it.

4. Load the content once:

   ```bash
   railway run --service <app-service> npm run seed
   ```

5. Confirm the deploy, including that the key and voice id actually work:

   ```bash
   curl https://your-app.up.railway.app/api/health?deep=1
   ```

   `?deep=1` calls ElevenLabs to verify the credentials and resolve the voice
   name. Plain `/api/health` doesn't, so the Railway health check never bills.

Connection details are handled in `lib/db.js`: no TLS for localhost or for
Railway's private network (`*.railway.internal`, which has no TLS terminator in
front of Postgres), TLS everywhere else. `PGSSLMODE=disable|require` overrides.

### Before it's public

- **`/api/gaps` and `/api/reload` answer only to localhost until `ADMIN_TOKEN`
  is set.** That rule is not keyed on `NODE_ENV` on purpose — forgetting to set
  an env var should not be what exposes them.
- **Everything in the knowledge base becomes public**, including any entry still
  flagged `is_placeholder`. Run `npm run gaps` and clear those first, or
  deactivate them: `UPDATE entries SET is_active = false WHERE is_placeholder;`
- **`/api/ask` is unauthenticated and unthrottled**, and each call writes a row
  to `queries`. That's the design — anyone can ask — but it is an unbounded
  write endpoint on a public URL. Add rate limiting if it gets attention.

## API

| Endpoint | Method | Purpose |
| --- | --- | --- |
| `/api/bootstrap` | GET | Name, greeting, starter questions, which voice and answer mode are active |
| `/api/ask` | POST | `{ question, raw }` → SSE stream (`meta`/`delta`/`done`), or JSON with `Accept: application/json` |
| `/api/speak` | POST | `{ text, speechToken }` → base64 audio. Rejects text it didn't sign |
| `/api/health` | GET | Database reachability, entry count; `?deep=1` also verifies the Gemini key and model |
| `/api/gaps` | GET | Unanswered questions and unfilled entries — **admin** |
| `/api/reload` | POST | Re-read the knowledge base from Postgres now — **admin** |

Admin endpoints require `Authorization: Bearer $ADMIN_TOKEN`, or a request from
localhost when no token is configured.

## Notes

- Press space to start or stop listening.
- The speaker button mutes the spoken reply; the text still types out.
- Recognition runs in the browser, so no audio leaves the visitor's machine —
  only the text transcript reaches the server.

# Knowledge base to-dos

Running backlog for growing the KB. Plan is one new question a day — add
it here when it's identified, check it off once it's answered and live.

## Pending

- [ ] **Add a specific example for "How do you handle team conflict?" (kb-028)** —
      currently a generic philosophy answer with no concrete story, added
      2026-09-13. Would be much stronger as a real STAR-format anecdote
      (situation/task/action/result) like kb-023 or kb-027. Once there's a
      real example, replace the `answer` (and add a `detail`) rather than
      adding a second entry.
- [ ] What is your favorite book, and why? — asked 2× in production, no
      answer yet. Right now it falls through to kb-011 (hobbies / writing a
      book) at 0.50 confidence, so the agent answers the wrong question. (Also sent as a fillable Word doc: `kb-gaps-to-fill.docx`.)
- [ ] How do you evaluate a new AI vendor or tool before adopting it? —
      asked 1×.

## Done

- [x] What is your approach to hiring and building teams? — covered by
      kb-030 (hiring philosophy), including the "hiring a data scientist"
      phrasing.
- [x] How do you approach mentoring junior engineers? (kb-031) — added
      2026-09-26.
- [x] What's your weakness? (kb-032) — added 2026-09-26.
- [x] Noesis described consistently (kb-005, kb-014) — was "a personal
      learning project"; now the venture Shridhar started as a founder and
      advises as Tech Advisor, matching profile.json. Fixed 2026-09-26.
- [x] How do you handle team conflict? (kb-028) — added 2026-09-13 as a
      general-philosophy answer (no specific story yet, see above).

## Workflow

1. Pick the next question (from here, or a new gap from `npm run gaps`
   against production).
2. Draft the answer — check it against Shridhar for accuracy before it
   goes in, since the agent speaks it as fact, verbatim.
3. Add the entry to `kb/knowledge-base.json` (id, question, patterns,
   keywords, answer, optional detail, tags).
4. `railway up --service voice-kb-app --ci` — ships the new JSON.
5. `railway ssh --service voice-kb-app -- npm run seed` — loads it into
   the live Postgres (upserts by id, safe to re-run).
6. `POST /api/reload` (Bearer $ADMIN_TOKEN) to refresh the in-memory
   cache immediately, or wait ~30s for KB_CACHE_MS.
7. Verify live with a real `/api/ask` call before calling it done.

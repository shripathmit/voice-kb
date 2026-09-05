'use strict';

require('./lib/env').load();

const http = require('node:http');
const fs = require('node:fs');
const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const path = require('node:path');

const { KnowledgeBase, normalise } = require('./lib/retrieve');
const db = require('./lib/db');
const tts = require('./lib/tts');
const llm = require('./lib/llm');
const seeder = require('./lib/seed');

const PORT = Number(process.env.PORT) || 5178;
const PUBLIC_DIR = path.join(__dirname, 'public');

// The knowledge base is small and changes rarely, so it is cached in memory and
// re-read on a timer. Editing a row in Postgres shows up within CACHE_TTL_MS
// without a restart; POST /api/reload makes it immediate.
const CACHE_TTL_MS = Number(process.env.KB_CACHE_MS) || 30_000;

// /api/gaps and /api/reload are operator endpoints. On a public URL they leak
// what visitors asked and hand anyone a way to hammer the database.
//
// The rule is deliberately not keyed on NODE_ENV: forgetting to set it on a
// host would silently expose them. Instead, with no ADMIN_TOKEN configured they
// answer only to loopback — which a request arriving through a platform proxy
// never is — so the insecure case is impossible to reach by omission.
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';

function isLoopback(req) {
  const address = req.socket.remoteAddress || '';
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function authoriseAdmin(req, res) {
  if (!ADMIN_TOKEN) {
    if (isLoopback(req)) return true;
    sendJson(res, 403, {
      error: 'Admin endpoints are local-only until ADMIN_TOKEN is set.',
    });
    return false;
  }

  const header = req.headers.authorization || '';
  const supplied = header.startsWith('Bearer ') ? header.slice(7) : '';
  const expected = Buffer.from(ADMIN_TOKEN);
  const got = Buffer.from(supplied);

  if (got.length !== expected.length || !crypto.timingSafeEqual(got, expected)) {
    sendJson(res, 401, { error: 'Unauthorized' });
    return false;
  }
  return true;
}

let kb = null;
let loadedAt = 0;
let loadError = null;
let inFlight = null;

async function refresh() {
  const data = await db.loadKnowledgeBase();
  kb = new KnowledgeBase(data);
  loadedAt = Date.now();
  loadError = null;
  return kb;
}

/** Returns the cached knowledge base, reloading if stale. Never loads twice at once. */
async function getKb({ force = false } = {}) {
  if (!force && kb && Date.now() - loadedAt < CACHE_TTL_MS) return kb;
  if (inFlight) return inFlight;

  inFlight = refresh()
    .catch((err) => {
      loadError = err;
      if (kb) {
        // Serve the last good copy rather than going dark on a blip.
        console.error(`[kb] reload failed, serving cached copy: ${err.message}`);
        return kb;
      }
      throw err;
    })
    .finally(() => {
      inFlight = null;
    });

  return inFlight;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.wav': 'audio/wav',
};

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function readBody(req, limit = 32 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * Parses a single-range `Range: bytes=start-end` header against a known file
 * size. Returns null for "no range requested" or "can't satisfy this range" —
 * callers should fall back to a full 200 response in the first case and
 * answer 416 in the second.
 */
function parseRange(header, size) {
  if (!header || !header.startsWith('bytes=')) return null;

  const [startStr, endStr] = header.slice(6).split('-', 2);
  let start = startStr === '' ? NaN : Number(startStr);
  let end = endStr === '' ? NaN : Number(endStr);

  if (Number.isNaN(start) && Number.isNaN(end)) return null;
  if (Number.isNaN(start)) {
    // "bytes=-500" means the last 500 bytes.
    start = Math.max(0, size - end);
    end = size - 1;
  } else if (Number.isNaN(end)) {
    end = size - 1;
  }

  if (start > end || start < 0 || end >= size) return { unsatisfiable: true };
  return { start, end };
}

/**
 * Serves a file from public/, honouring HTTP Range requests.
 *
 * This is not an optimisation — it is a correctness requirement. iOS Safari's
 * <audio>/<video> loading probes a media resource with an initial Range
 * request before committing to playback, and a server that ignores the header
 * and always returns a full 200 causes Safari to refuse the resource outright
 * — surfacing to the page as a bare `MediaError` with no explanation of why.
 */
async function serveStatic(req, res, pathname) {
  const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
  const filePath = path.join(PUBLIC_DIR, relative);

  // Keep requests inside public/.
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  let stat;
  try {
    stat = await fsp.stat(filePath);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not found');
    return;
  }

  const contentType = MIME[path.extname(filePath)] || 'application/octet-stream';
  const baseHeaders = {
    'content-type': contentType,
    'cache-control': 'no-store',
    'accept-ranges': 'bytes',
  };

  const range = parseRange(req.headers.range, stat.size);

  if (range && range.unsatisfiable) {
    res.writeHead(416, { ...baseHeaders, 'content-range': `bytes */${stat.size}` });
    res.end();
    return;
  }

  if (range) {
    res.writeHead(206, {
      ...baseHeaders,
      'content-range': `bytes ${range.start}-${range.end}/${stat.size}`,
      'content-length': range.end - range.start + 1,
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    fs.createReadStream(filePath, { start: range.start, end: range.end }).pipe(res);
    return;
  }

  res.writeHead(200, { ...baseHeaders, 'content-length': stat.size });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  fs.createReadStream(filePath).pipe(res);
}

/* -------------------------------------------------------------------------
 * Speech authorisation
 *
 * /api/speak reaches a metered, billed API from a public URL. It used to be
 * guarded by checking the text against the knowledge base, which stops working
 * the moment a model writes the answer instead of a row supplying it.
 *
 * Instead, whatever produces text signs it, and /api/speak verifies the
 * signature. The rule becomes "this server will only speak words it produced",
 * which holds no matter where the words came from.
 * ---------------------------------------------------------------------------
 */

// Preferring an explicit secret, then the admin token, then a per-boot random
// value. The random fallback means tokens do not survive a restart — harmless,
// since the client asks a fresh question to get a fresh token.
const SPEECH_SECRET =
  process.env.SPEECH_SECRET || process.env.ADMIN_TOKEN || crypto.randomBytes(32).toString('hex');

function signText(text) {
  return crypto.createHmac('sha256', SPEECH_SECRET).update(text).digest('hex');
}

function verifyText(text, token) {
  if (typeof token !== 'string' || token.length === 0) return false;
  const expected = Buffer.from(signText(text));
  const got = Buffer.from(token);
  return got.length === expected.length && crypto.timingSafeEqual(got, expected);
}

/* ---------------- server-sent events ---------------- */

function sseInit(res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    // Railway sits behind a proxy that will otherwise buffer the whole
    // response and defeat the point of streaming.
    'x-accel-buffering': 'no',
  });
}

function sseSend(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/**
 * Splits a finished answer into sentence-sized pieces for pipelined
 * synthesis: audio for the first sentence can start playing while the rest
 * are still being synthesised, instead of the listener waiting for the whole
 * answer to be voiced as one clip before hearing anything.
 *
 * Fragments under 20 characters are folded into the previous chunk — a lone
 * "Yes." or "In twenty twenty-three." played as its own clip sounds clipped
 * and staccato rather than like a pause in normal speech.
 */
function splitIntoSpeechChunks(text) {
  const sentences = text.match(/[^.!?]+[.!?]+(?:\s+|$)/g) || [text];
  const chunks = [];

  for (const raw of sentences) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    if (chunks.length && trimmed.length < 20) chunks[chunks.length - 1] += ' ' + trimmed;
    else chunks.push(trimmed);
  }

  return chunks.length ? chunks : [text.trim()];
}

/**
 * The streaming twin of splitIntoSpeechChunks: same sentence-boundary rule
 * and same short-fragment-merge rule, but applied as text arrives token by
 * token instead of to one finished string.
 *
 * The reason this exists at all, rather than just waiting for the full
 * answer and calling splitIntoSpeechChunks once: it lets `onChunkReady` fire
 * — and TTS synthesis start — for an early sentence while Gemini is still
 * generating the rest of the answer, instead of paying for the whole
 * generation call before any synthesis begins at all. A sentence is not
 * handed over the moment it is seen, though: the merge rule needs to know
 * whether the *next* sentence is a short fragment before it can be sure a
 * given sentence is not about to be merged into, so each one is held back
 * until the one after it has started arriving.
 */
function createIncrementalChunker(onChunkReady) {
  const sentenceRe = /^[^.!?]+[.!?]+(?:\s+|$)/;
  let buffer = '';
  let pending = null; // a settled sentence not yet confirmed to be its own chunk

  function normalise(raw) {
    return raw.replace(/\s+/g, ' ').trim();
  }

  function feed(delta) {
    buffer += delta;
    let match;
    while ((match = sentenceRe.exec(buffer)) !== null) {
      const trimmed = normalise(match[0]);
      buffer = buffer.slice(match[0].length);
      if (!trimmed) continue;
      if (pending !== null && trimmed.length < 20) {
        pending += ' ' + trimmed;
      } else {
        if (pending !== null) onChunkReady(pending);
        pending = trimmed;
      }
    }
  }

  /** Whatever never reached a `.!?` terminator becomes the final piece. */
  function finish() {
    const tail = normalise(buffer);
    buffer = '';
    if (pending !== null && tail && tail.length < 20) {
      onChunkReady(pending + ' ' + tail);
    } else {
      if (pending !== null) onChunkReady(pending);
      if (tail) onChunkReady(tail);
    }
    pending = null;
  }

  return { feed, finish };
}

/**
 * Synthesises one chunk's audio, checking the cache first — the same logic
 * `/api/speak` uses, factored out so the ask pipeline can call it per chunk.
 * Returns null when no provider is configured; the client falls back to its
 * own browser voice for that chunk rather than the answer going silent.
 */
async function synthesiseChunkAudio(text) {
  if (!tts.isConfigured()) return null;

  const cfg = tts.config();
  const hash = tts.cacheKey(text, cfg);

  try {
    const cached = await db.getCachedAudio(hash);
    if (cached) {
      return { audioBase64: cached.audio.toString('base64'), mimeType: cached.mime_type || 'audio/mpeg', alignment: cached.alignment };
    }
  } catch (err) {
    console.error(`[tts] cache read failed: ${err.message}`);
  }

  try {
    const spoken = await tts.synthesise(text);
    db.putCachedAudio({
      hash,
      provider: spoken.provider,
      voiceId: spoken.voiceId,
      modelId: spoken.modelId,
      mimeType: spoken.mimeType,
      text,
      audio: spoken.audio,
      alignment: spoken.alignment,
    }).catch((err) => console.error(`[tts] cache write failed: ${err.message}`));

    return { audioBase64: spoken.audio.toString('base64'), mimeType: spoken.mimeType, alignment: spoken.alignment };
  } catch (err) {
    // One chunk failing to synthesise should not cost the listener the rest
    // of the answer — that chunk just arrives text-only and the client reads
    // it with the browser voice instead.
    console.error(`[tts] chunk synthesis ${err.code || 'ERROR'}: ${err.message}`);
    return null;
  }
}

/**
 * Produces the answer to a question, plus (when `synthesiseAudio` is true)
 * the exact per-sentence chunk list — text and an already-in-flight TTS
 * promise for each — that the caller should send on. Building that list
 * here rather than handing back plain text for the caller to re-chunk keeps
 * one single source of truth: the text a chunk's audio was synthesised from
 * is always the literal text the client is later told to display for it.
 *
 * When Gemini is answering (not a cache hit, not the no-LLM path), each
 * chunk's TTS call is fired the moment that sentence is confirmed complete
 * — while Gemini is still generating the rest of the answer — rather than
 * waiting for the full generation to finish before any synthesis begins.
 * Sentence n and the LLM call finishing generation of sentences n+1..end now
 * happen at the same time instead of one after the other, which is where
 * most of the old "silence before the first word" delay came from: a whole
 * LLM call (typically 1-2s) that used to be pure dead time in front of TTS,
 * now overlapped with it instead.
 *
 * Keyword retrieval always runs — it is in-memory and free, and it supplies the
 * source entry, its long-form `detail`, and the entry id used for gap logging.
 * When a model is configured its prose replaces the stored answer text, but
 * everything around the answer still comes from retrieval.
 *
 * @param {{question: string, kb: object, synthesiseAudio?: boolean}} options
 */
async function resolveAnswer({ question, kb, synthesiseAudio = true }) {
  const retrieved = kb.answer(question);

  const base = {
    detail: retrieved.matched ? retrieved.detail : null,
    source: retrieved.source,
    confidence: retrieved.confidence,
    alternatives: retrieved.alternatives,
  };

  const chunksFromText = (text) =>
    splitIntoSpeechChunks(text).map((t) => ({
      text: t,
      synthPromise: synthesiseAudio ? synthesiseChunkAudio(t) : null,
    }));

  if (!llm.isConfigured()) {
    return { ...base, answer: retrieved.answer, matched: retrieved.matched, via: retrieved.via, chunks: chunksFromText(retrieved.answer) };
  }

  // Repeat questions should cost nothing. The knowledge base version is in the
  // key so that editing an entry retires every cached answer at once.
  let cacheHash = null;
  try {
    const version = await db.knowledgeBaseVersion();
    cacheHash = crypto
      .createHash('sha256')
      // The prompt version is in the key so that changing how the model is
      // instructed retires the answers the previous instruction produced.
      .update(`${llm.PROMPT_VERSION}|${llm.config().modelId}|${version}|${normalise(question)}`)
      .digest('hex');

    const cached = await db.getCachedAnswer(cacheHash);
    if (cached) {
      return {
        ...base,
        answer: cached.answer,
        matched: cached.matched,
        detail: cached.matched ? base.detail : null,
        via: 'gemini-cache',
        chunks: chunksFromText(cached.answer),
      };
    }
  } catch (err) {
    console.error(`[ask] answer cache unavailable: ${err.message}`);
  }

  const readyChunks = [];
  const chunker = createIncrementalChunker((text) => {
    readyChunks.push({ text, synthPromise: synthesiseAudio ? synthesiseChunkAudio(text) : null });
  });

  try {
    let text = '';
    for await (const delta of llm.streamAnswer(question, kb)) {
      text += delta;
      chunker.feed(delta);
    }
    chunker.finish();

    const result = llm.finalise(text, kb);

    if (cacheHash) {
      db.putCachedAnswer({
        hash: cacheHash,
        question,
        answer: result.answer,
        entryIds: retrieved.source ? [retrieved.source.id] : [],
        matched: result.matched,
        model: result.model,
      }).catch((err) => console.error(`[ask] could not cache answer: ${err.message}`));
    }

    return {
      ...base,
      answer: result.answer,
      matched: result.matched,
      detail: result.matched ? base.detail : null,
      via: 'gemini',
      // readyChunks was built from the same literal text finalise() just
      // validated, so it is exactly right whether the model produced a real
      // answer or (legitimately) came back with the fallback sentence.
      chunks: readyChunks,
    };
  } catch (err) {
    // Never let a model failure cost the visitor their answer. Anything in
    // readyChunks was speculative synthesis for text that will never be
    // shown — its promises just resolve unused in the background, nothing
    // to cancel or clean up.
    console.error(`[ask] ${err.code || 'ERROR'} from Gemini, using retrieval: ${err.message}`);
    return { ...base, answer: retrieved.answer, matched: retrieved.matched, via: `${retrieved.via}-fallback`, chunks: chunksFromText(retrieved.answer) };
  }
}

async function handleAsk({ res, question, raw, kb, stream }) {
  const started = Date.now();

  if (!stream) {
    // Nothing here ever plays audio — the JSON path exists for curl/basic
    // compatibility, and a client on it would call /api/speak separately if
    // it wanted sound. Skipping synthesis avoids paying for TTS calls a
    // response like this never uses.
    const result = await resolveAnswer({ question, kb, synthesiseAudio: false });
    finishAsk({ question, raw, result, started });
    const { chunks, ...jsonSafe } = result; // chunks holds live Promises, not JSON
    sendJson(res, 200, {
      question,
      raw,
      ...jsonSafe,
      speechToken: signText(result.answer),
      answeredAt: new Date().toISOString(),
    });
    return;
  }

  sseInit(res);
  sseSend(res, 'meta', { question, raw });

  // resolveAnswer already kicked off each chunk's TTS synthesis the moment
  // that sentence was confirmed complete — for the Gemini path, that started
  // while later sentences were still being generated, not after. What
  // happens here is just collecting results and sending them, strictly in
  // order (chunk 2 is never emitted before chunk 1), so playback order on
  // the client is unaffected by however the synthesis calls actually finish.
  let result;
  try {
    result = await resolveAnswer({ question, kb });
  } catch (err) {
    console.error('[ask] failed:', err);
    sseSend(res, 'error', { error: err.message });
    res.end();
    return;
  }

  finishAsk({ question, raw, result, started });

  for (let i = 0; i < result.chunks.length; i += 1) {
    const { text, synthPromise } = result.chunks[i];
    const spoken = await synthPromise;
    sseSend(res, 'chunk', {
      index: i,
      isLast: i === result.chunks.length - 1,
      text,
      speechToken: signText(text),
      audioBase64: spoken ? spoken.audioBase64 : null,
      mimeType: spoken ? spoken.mimeType : null,
      alignment: spoken ? spoken.alignment : null,
    });
  }

  sseSend(res, 'done', {
    answer: result.answer,
    detail: result.detail,
    matched: result.matched,
    source: result.source,
    confidence: result.confidence,
    via: result.via,
    speechToken: signText(result.answer),
    answeredAt: new Date().toISOString(),
  });
  res.end();
}

/** Logging and the gap record, shared by both response shapes. */
function finishAsk({ question, raw, result, started }) {
  db.logQuery({
    raw,
    question,
    matched: result.matched,
    entryId: result.source ? result.source.id : null,
    confidence: result.confidence,
    via: result.via,
  });

  console.log(
    `[ask] "${question}" -> ${result.source ? result.source.id : 'fallback'} ` +
      `(${result.via}, ${result.confidence}, ${Date.now() - started}ms)`,
  );
}

async function handleApi(req, res, pathname) {
  if (pathname === '/api/health') {
    try {
      await db.ping();
      const current = await getKb();
      sendJson(res, 200, {
        ok: true,
        database: 'up',
        target: db.describeTarget(),
        entries: current.data.entries.length,
        cacheAgeMs: Date.now() - loadedAt,
        // `?deep=1` actually calls the providers to confirm keys and models.
        // The default stays cheap so the Railway health check never bills.
        tts: new URL(req.url, 'http://x').searchParams.has('deep')
          ? await tts.check()
          : {
              configured: tts.isConfigured(),
              provider: tts.config().provider,
              voiceId: tts.config().voiceId,
              modelId: tts.config().modelId,
            },
        llm: new URL(req.url, 'http://x').searchParams.has('deep')
          ? await llm.check()
          : { configured: llm.isConfigured(), modelId: llm.config().modelId },
      });
    } catch (err) {
      sendJson(res, 503, { ok: false, database: 'down', error: err.message, target: db.describeTarget() });
    }
    return true;
  }

  if (pathname === '/api/bootstrap') {
    try {
      const current = await getKb();
      const subject = current.data.subject || {};
      sendJson(res, 200, {
        name: subject.shortName || subject.name || 'me',
        greeting: current.data.greeting,
        subGreeting: current.data.subGreeting || '',
        suggestions: current.data.starters || current.suggestions(4),
        placeholder: Boolean(current.data.placeholder),
        entries: current.data.entries.length,
        // Tells the client whether to ask this server for audio or use the
        // browser's own voice.
        voice: tts.isConfigured() ? 'server' : 'browser',
        answers: llm.isConfigured() ? 'generated' : 'stored',
      });
    } catch (err) {
      sendJson(res, 503, { error: `Knowledge base unavailable: ${err.message}` });
    }
    return true;
  }

  if (pathname === '/api/ask') {
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'Use POST' });
      return true;
    }

    let payload;
    try {
      payload = JSON.parse((await readBody(req)) || '{}');
    } catch (err) {
      sendJson(res, 400, { error: `Invalid request body: ${err.message}` });
      return true;
    }

    const question = typeof payload.question === 'string' ? payload.question.trim() : '';
    if (!question) {
      sendJson(res, 400, { error: 'Missing "question"' });
      return true;
    }

    let current;
    try {
      current = await getKb();
    } catch (err) {
      sendJson(res, 503, { error: `Knowledge base unavailable: ${err.message}` });
      return true;
    }

    const raw = typeof payload.raw === 'string' ? payload.raw : question;

    // Streaming is the default for browsers; the JSON form keeps every
    // curl-based check in this project working unchanged.
    const wantsStream = !/application\/json/.test(req.headers.accept || '');

    await handleAsk({ req, res, question, raw, kb: current, stream: wantsStream });
    return true;
  }

  // Speech synthesis. Cached in Postgres, so a given answer is paid for once.
  if (pathname === '/api/speak') {
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'Use POST' });
      return true;
    }

    let payload;
    try {
      payload = JSON.parse((await readBody(req)) || '{}');
    } catch (err) {
      sendJson(res, 400, { error: `Invalid request body: ${err.message}` });
      return true;
    }

    const text = typeof payload.text === 'string' ? payload.text.trim() : '';
    if (!text) {
      sendJson(res, 400, { error: 'Missing "text"' });
      return true;
    }

    // Authorisation before capability: only speak words this server produced.
    // Every miss here costs money on a public URL, so the signature is what
    // stops it being an open proxy to a metered API.
    if (!verifyText(text, payload.speechToken)) {
      sendJson(res, 401, { error: 'Invalid or missing speechToken', fallback: 'browser' });
      return true;
    }

    if (!tts.isConfigured()) {
      sendJson(res, 503, { error: 'No speech provider is configured', fallback: 'browser' });
      return true;
    }

    const cfg = tts.config();
    const hash = tts.cacheKey(text, cfg);

    try {
      const cached = await db.getCachedAudio(hash);
      if (cached) {
        sendJson(res, 200, {
          audioBase64: cached.audio.toString('base64'),
          // Providers differ — Gemini stores WAV, ElevenLabs MP3 — so the type
          // travels with the row rather than being assumed.
          mimeType: cached.mime_type || 'audio/mpeg',
          alignment: cached.alignment,
          cached: true,
        });
        return true;
      }
    } catch (err) {
      // A cache failure is not a synthesis failure — fall through and generate.
      console.error(`[tts] cache read failed: ${err.message}`);
    }

    try {
      const spoken = await tts.synthesise(text);
      console.log(`[tts] ${spoken.provider} synthesised ${text.length} chars as ${spoken.voiceId}`);

      db.putCachedAudio({
        hash,
        provider: spoken.provider,
        voiceId: spoken.voiceId,
        modelId: spoken.modelId,
        mimeType: spoken.mimeType,
        text,
        audio: spoken.audio,
        alignment: spoken.alignment,
      }).catch((err) => console.error(`[tts] cache write failed: ${err.message}`));

      sendJson(res, 200, {
        audioBase64: spoken.audio.toString('base64'),
        mimeType: spoken.mimeType,
        alignment: spoken.alignment,
        cached: false,
      });
    } catch (err) {
      console.error(`[tts] ${err.code || 'ERROR'}: ${err.message}`);
      // The client can always fall back to browser speech, so this is not fatal.
      sendJson(res, 502, { error: err.message, code: err.code || 'ERROR', fallback: 'browser' });
    }
    return true;
  }

  // What people asked that the knowledge base could not answer — the list of
  // answers still worth writing.
  if (pathname === '/api/gaps') {
    if (!authoriseAdmin(req, res)) return true;
    try {
      sendJson(res, 200, {
        gaps: await db.gaps(50),
        stats: await db.stats(),
        placeholders: await db.placeholders(),
        tts: await db.ttsCacheStats(),
      });
    } catch (err) {
      sendJson(res, 503, { error: err.message });
    }
    return true;
  }

  if (pathname === '/api/reload') {
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'Use POST' });
      return true;
    }
    if (!authoriseAdmin(req, res)) return true;
    try {
      const current = await getKb({ force: true });
      sendJson(res, 200, { reloaded: true, entries: current.data.entries.length });
    } catch (err) {
      sendJson(res, 503, { error: err.message });
    }
    return true;
  }

  return false;
}

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, `http://${req.headers.host}`);

  try {
    if (pathname.startsWith('/api/')) {
      if (await handleApi(req, res, pathname)) return;
      sendJson(res, 404, { error: 'Unknown endpoint' });
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end('Method not allowed');
      return;
    }

    await serveStatic(req, res, pathname);
  } catch (err) {
    console.error('[server]', err);
    if (!res.headersSent) sendJson(res, 500, { error: 'Internal error' });
  }
});

/**
 * Applies the schema at boot. Idempotent, and non-fatal on failure.
 *
 * It runs here rather than in the start command so that a database that is slow
 * or briefly unreachable cannot stop the process from binding a port. A server
 * that comes up and reports "database down" is diagnosable; one that exits
 * before printing anything is not.
 */
async function applyMigrations() {
  if (process.env.SKIP_MIGRATE === '1') return;

  try {
    const sql = await fsp.readFile(path.join(__dirname, 'db', 'schema.sql'), 'utf8');
    await db.pool.query(sql);
    console.log('[migrate] schema applied');
  } catch (err) {
    console.error(`[migrate] skipped: ${err.message}`);
  }
}

async function start() {
  console.log(`[boot] node ${process.version}, port ${PORT}`);
  console.log(`[db] ${db.describeTarget()}`);

  // Bind first. Whatever happens with the database, the process is up and its
  // logs are reachable.
  server.listen(PORT, () => console.log(`voice-kb listening on port ${PORT}`));

  await applyMigrations();

  // A brand new environment has an empty database and, on a private network,
  // no way to reach it from a laptop to seed it. So provision from the JSON in
  // the image — but only when empty, never over existing content.
  if (process.env.AUTO_SEED !== '0') {
    try {
      if (await seeder.isEmpty()) {
        const result = await seeder.seed();
        console.log(`[seed] empty database provisioned — ${result.entries} entries`);
      }
    } catch (err) {
      console.error(`[seed] could not provision: ${err.message}`);
    }
  }

  try {
    const current = await getKb({ force: true });
    console.log(`[kb] loaded ${current.data.entries.length} entries`);
  } catch (err) {
    console.error(`[kb] could not load at boot: ${err.message}`);
    console.error('[kb] run `npm run seed` if the database is empty');
  }
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => db.pool.end().then(() => process.exit(0)));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}

start();

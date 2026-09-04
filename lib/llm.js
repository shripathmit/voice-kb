'use strict';

/**
 * Gemini answer generation, grounded in the knowledge base.
 *
 * The agent speaks as a real person, to strangers, in something close to his
 * voice. So the model's job is to *phrase* what the knowledge base already
 * says — never to add to it. An invented employer, school, or date would be
 * asserted confidently in the first person and read as fact.
 *
 * When no key is set, or a call fails, callers fall back to the keyword
 * retrieval in lib/retrieve.js, which returns stored text verbatim. The app
 * must never hard-depend on this module.
 */

const gemini = require('./tts/gemini');

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

const DEFAULT_MODEL = 'gemini-3.7-flash';

// Bump whenever the system instruction changes: it is part of the answer cache
// key, so without it a prompt fix would keep serving the answers the old prompt
// produced. v2 = interpret speech-recognition errors charitably.
const PROMPT_VERSION = 'v4';

// In a voice interface a long wait is worse than a stored answer — silence
// reads as broken. Fail over to retrieval quickly rather than holding the
// line. Normal generation lands in 0.7-1.5s (see [ask] logs); 6s is generous
// headroom over that, not a typical-case budget. A real stall was observed
// running the full previous 10s budget before failing over — cutting the
// worst-case silent wait matters more here than tolerating a slow outlier.
const TIMEOUT_MS = Number(process.env.GEMINI_TIMEOUT_MS) || 6_000;

function config() {
  return {
    // Shares the key, the placeholder handling, and the trimming with the
    // speech side — one key configures both halves of the agent.
    apiKey: gemini.config().apiKey,
    modelId: (process.env.GEMINI_MODEL || DEFAULT_MODEL).trim(),
  };
}

function isConfigured() {
  return Boolean(config().apiKey);
}

/**
 * Entries the model is allowed to draw on.
 *
 * Placeholder entries are withheld. They hold invented filler — an education,
 * a location, a contact line nobody has written yet — and handing them to a
 * model told to answer confidently in the first person is the single most
 * likely way this system states something false about its subject. Withheld,
 * those questions reach the fallback instead, which is the honest answer.
 */
function groundingEntries(kb) {
  return (kb.data.entries || []).filter((entry) => !entry.placeholder);
}

function buildSystemInstruction(kb) {
  const subject = kb.data.subject || {};
  const name = subject.name || 'the subject';

  return [
    `You are answering out loud as ${name}, in the first person, to someone who has asked you a question.`,
    '',
    'THE QUESTION CAME FROM SPEECH RECOGNITION. It may be garbled, misheard, missing words,',
    'or oddly phrased — "what did you put in Alexa" means "what did you do at Alexa".',
    'Interpret it charitably. Work out what the person most likely meant and answer the closest',
    'question the entries do cover. Do not refuse over wording.',
    '',
    'ABSOLUTE RULE: every fact in your answer must already appear in the reference entries below.',
    'You may rephrase, condense, reorder, merge entries, and adapt tone to the question.',
    'You may not add a fact that is not in the entries — no employers, dates, places, numbers,',
    'opinions, names, or job titles of your own invention. Do not guess. Do not fill gaps.',
    '',
    'Be generous about what counts as covered, and strict about what counts as a fact.',
    'If any entry is even partly relevant, answer from it. Only when nothing in the entries',
    'relates to the question at all, reply with exactly this sentence and nothing else:',
    '',
    kb.data.fallback,
    '',
    'STYLE: your answer is going to be read aloud by a speech synthesiser.',
    '- Two to five sentences. Shorter is better.',
    '- No bullet points, no numbered lists, no headings, no URLs, no emoji, no markdown.',
    '- Write numbers as words: "twenty percent", not "20%". "four point seven", not "4.7".',
    '- Sound like a person talking, not like a document being read.',
    '',
    'REFERENCE ENTRIES:',
    '',
    groundingEntries(kb)
      .map((entry) => {
        const parts = [`[${entry.id}] Q: ${entry.question}`, `A: ${entry.answer}`];
        if (entry.detail) parts.push(`More detail: ${entry.detail}`);
        return parts.join('\n');
      })
      .join('\n\n'),
  ].join('\n');
}

function requestBody(question, kb) {
  return {
    systemInstruction: { parts: [{ text: buildSystemInstruction(kb) }] },
    contents: [{ role: 'user', parts: [{ text: question }] }],
    generationConfig: {
      // Low but not zero: enough variation to sound human across repeats,
      // not enough to wander off the source material.
      temperature: 0.3,
      // Thinking tokens are charged against this budget. At 400 the model spent
      // 385 reasoning and had 11 left for the answer, which came back truncated
      // or empty and looked exactly like a refusal. Headroom is cheap; silent
      // truncation is not.
      maxOutputTokens: 1200,
      topP: 0.9,
      // This task is rephrasing grounded text, not reasoning. Turning thinking
      // off removes the failure entirely and takes seconds off every answer.
      thinkingConfig: { thinkingBudget: 0 },
    },
  };
}

/** Pulls the text out of one streamed chunk, whatever shape it arrives in. */
function textFromChunk(chunk) {
  const parts = chunk?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return '';
  return parts.map((p) => p.text || '').join('');
}

/**
 * Streams an answer, yielding text as it arrives.
 *
 * @param {string} question
 * @param {import('./retrieve').KnowledgeBase} kb
 * @yields {string} incremental text
 */
async function* streamAnswer(question, kb) {
  const cfg = config();
  if (!cfg.apiKey) throw Object.assign(new Error('Gemini is not configured'), { code: 'NOT_CONFIGURED' });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let response;
  try {
    response = await fetch(
      `${API_BASE}/models/${encodeURIComponent(cfg.modelId)}:streamGenerateContent?alt=sse`,
      {
        method: 'POST',
        signal: controller.signal,
        headers: {
          // Header, not the documented `?key=` parameter: secrets in URLs end
          // up in access logs and proxy history.
          'x-goog-api-key': cfg.apiKey,
          'content-type': 'application/json',
        },
        body: JSON.stringify(requestBody(question, kb)),
      },
    );
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') {
      throw Object.assign(new Error(`Gemini timed out after ${TIMEOUT_MS}ms`), { code: 'TIMEOUT' });
    }
    throw Object.assign(new Error(`Gemini unreachable: ${err.message}`), { code: 'NETWORK' });
  }

  if (!response.ok) {
    clearTimeout(timer);
    const body = await response.text().catch(() => '');
    const err = new Error(`Gemini returned ${response.status}${body ? `: ${body.slice(0, 300)}` : ''}`);
    err.code =
      response.status === 400 || response.status === 403 ? 'BAD_KEY'
      : response.status === 404 ? 'BAD_MODEL'
      : response.status === 429 ? 'RATE_LIMIT'
      : 'UPSTREAM';
    err.status = response.status;
    throw err;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let finishReason = null;
  let produced = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // SSE frames are separated by a blank line, and a frame may span reads.
      //
      // The separator must tolerate CRLF: Google sends \r\n\r\n, and matching
      // only \n\n silently parses nothing at all — every answer comes back
      // empty and is indistinguishable from the model declining to answer.
      let match;
      while ((match = /\r?\n\r?\n/.exec(buffer)) !== null) {
        const frame = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);

        for (const rawLine of frame.split(/\r?\n/)) {
          const line = rawLine.trimEnd();
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (!data || data === '[DONE]') continue;

          let parsed;
          try {
            parsed = JSON.parse(data);
          } catch {
            continue; // A partial frame is not worth failing the answer over.
          }

          finishReason = parsed?.candidates?.[0]?.finishReason || finishReason;

          const text = textFromChunk(parsed);
          if (text) {
            produced += text.length;
            yield text;
          }
        }
      }
    }
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
  }

  // A truncated or empty generation must not be mistaken for "the knowledge
  // base doesn't cover this" — that turns an internal failure into a confident
  // refusal. Raising it sends the caller to retrieval, which has a real answer.
  if (finishReason && finishReason !== 'STOP') {
    throw Object.assign(new Error(`Gemini stopped early (${finishReason})`), { code: 'TRUNCATED' });
  }
  if (produced === 0) {
    throw Object.assign(new Error('Gemini returned no text'), { code: 'EMPTY' });
  }
}

/**
 * Non-streaming convenience wrapper.
 *
 * @returns {Promise<{answer: string, matched: boolean, model: string}>}
 */
async function answer(question, kb) {
  let text = '';
  for await (const chunk of streamAnswer(question, kb)) text += chunk;
  return finalise(text, kb);
}

/**
 * Tidies generated text and decides whether it counts as an answer.
 *
 * The model is told to return the fallback sentence verbatim when it cannot
 * answer; comparing against it is how an unanswered question still gets logged
 * as a gap rather than as a successful answer.
 */
function finalise(text, kb) {
  const cleaned = String(text || '')
    .replace(/\s+/g, ' ')
    .trim();

  const fallback = kb.data.fallback;
  const normalise = (value) => value.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
  const isFallback = !cleaned || normalise(cleaned) === normalise(fallback);

  return {
    answer: isFallback ? fallback : cleaned,
    matched: !isFallback,
    model: config().modelId,
  };
}

/** Confirms the key and model work. Used by /api/health?deep=1. */
async function check() {
  const cfg = config();
  if (!cfg.apiKey) return { configured: false, ok: false, reason: 'no api key' };

  try {
    const response = await fetch(`${API_BASE}/models/${encodeURIComponent(cfg.modelId)}`, {
      headers: { 'x-goog-api-key': cfg.apiKey },
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) {
      return { configured: true, ok: false, modelId: cfg.modelId, reason: `model lookup returned ${response.status}` };
    }
    return { configured: true, ok: true, modelId: cfg.modelId };
  } catch (err) {
    return { configured: true, ok: false, modelId: cfg.modelId, reason: err.message };
  }
}

module.exports = {
  PROMPT_VERSION,
  config,
  isConfigured,
  streamAnswer,
  answer,
  finalise,
  check,
  buildSystemInstruction,
  groundingEntries,
  DEFAULT_MODEL,
};

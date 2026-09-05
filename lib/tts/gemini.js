'use strict';

/**
 * Gemini text-to-speech provider.
 *
 * Two things differ from ElevenLabs and both matter:
 *
 *  1. Gemini returns raw PCM, not a container format. No browser will play it,
 *     so a WAV header is added here — once, at synthesis — and WAV is what
 *     lands in the cache and goes to the client.
 *  2. There are no character timings, so the on-screen text cannot follow the
 *     voice syllable by syllable. The client falls back to playback position,
 *     which is still accurate, just coarser.
 */

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const PROVIDER = 'gemini';

// The API ships 30 prebuilt voices described only by manner, never by gender.
// Aoede is "breezy", a middle-pitch read. Run `node tools/voice-samples.js` to
// hear the alternatives.
const DEFAULT_VOICE = 'Aoede';

/**
 * Gemini's TTS models are still generative models: handed bare text they may
 * try to *respond* to it instead of reading it, which the API rejects with
 * "Model tried to generate text, but it should only be used for TTS".
 *
 * Phrasing the request as a spoken instruction is what makes it read rather
 * than reply. It doubles as the tone control — the style words are followed,
 * not spoken.
 */
const DEFAULT_STYLE = 'Say the following in a warm, natural, conversational tone';

function buildPrompt(text) {
  const style = (process.env.GEMINI_TTS_STYLE || DEFAULT_STYLE).trim().replace(/:\s*$/, '');
  return `${style}: ${text}`;
}

// Both TTS models are preview and could be renamed. Pinned via env so a change
// upstream is a variable edit, not a redeploy. Streaming (see synthesise())
// needs 3.1+ — gemini-2.5-flash-preview-tts still works but only ever returns
// its audio as one frame at the end, none of the streaming latency win.
const DEFAULT_MODEL = 'gemini-3.1-flash-tts-preview';
// A streamed clip for one sentence lands in ~2-3s in practice (measured
// against production: ~570ms to first byte, ~2.6s to finish). 10s leaves
// generous headroom over that without leaving a stalled call silent for as
// long as the old 30s default did — matches the same reasoning applied to
// GEMINI_TIMEOUT_MS in lib/llm.js.
const TIMEOUT_MS = Number(process.env.GEMINI_TTS_TIMEOUT_MS) || 10_000;

// Hosting platforms refuse to store an empty variable, so the slot is created
// holding this instead. Treating it as "no key" lets the variable exist and be
// self-explanatory in a dashboard without the app pretending it is configured.
const PLACEHOLDER_KEY = 'PASTE_YOUR_GEMINI_API_KEY_HERE';

/**
 * Reads the key, trimmed.
 *
 * Trimming matters: keys are pasted by hand, and a trailing newline or space
 * produces a 400 from the API that reads like an invalid key rather than a
 * copy-paste artefact.
 */
function readApiKey() {
  const raw = (process.env.GEMINI_API_KEY || '').trim();
  return raw === PLACEHOLDER_KEY ? '' : raw;
}

function config() {
  return {
    provider: PROVIDER,
    apiKey: readApiKey(),
    voiceId: (process.env.GEMINI_TTS_VOICE || DEFAULT_VOICE).trim(),
    modelId: (process.env.GEMINI_TTS_MODEL || DEFAULT_MODEL).trim(),
    // Part of the cache key: changing the tone changes the audio, so cached
    // clips have to be retired when it changes.
    style: (process.env.GEMINI_TTS_STYLE || DEFAULT_STYLE).trim(),
  };
}

function isConfigured() {
  return Boolean(config().apiKey);
}

/**
 * Builds a 44-byte canonical WAV header for 16-bit PCM.
 *
 * @param {number} dataLength bytes of sample data
 * @param {{sampleRate: number, channels: number, bitsPerSample: number}} format
 */
function wavHeader(dataLength, { sampleRate, channels, bitsPerSample }) {
  const header = Buffer.alloc(44);
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  const blockAlign = (channels * bitsPerSample) / 8;

  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataLength, 4); // file size minus the first 8 bytes
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // PCM fmt chunk length
  header.writeUInt16LE(1, 20); // audio format 1 = PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataLength, 40);

  return header;
}

function pcmToWav(pcm, format) {
  return Buffer.concat([wavHeader(pcm.length, format), pcm]);
}

/**
 * Reads the audio format out of a response mime type.
 *
 * Gemini reports PCM as `audio/L16;codec=pcm;rate=24000`. The rate is parsed
 * rather than assumed — guessing it wrong does not fail loudly, it just plays
 * the answer at the wrong pitch and speed, which is a miserable thing to debug.
 */
function parseAudioFormat(mimeType) {
  const type = String(mimeType || '');
  const rate = /rate=(\d+)/i.exec(type);

  if (!rate) {
    throw Object.assign(
      new Error(`Gemini returned audio with no sample rate to parse: "${type}"`),
      { code: 'UPSTREAM' },
    );
  }

  // L16 means 16-bit linear PCM. Nothing else has been observed from this API,
  // so anything else is treated as unknown rather than assumed compatible.
  const bits = /L(\d+)/i.exec(type);
  const bitsPerSample = bits ? Number(bits[1]) : 16;

  return { sampleRate: Number(rate[1]), channels: 1, bitsPerSample };
}

/**
 * Opens the streaming TTS call and yields each SSE frame's raw PCM slice as
 * it arrives, in order — the shared plumbing behind both `synthesise()`
 * (accumulates every frame, returns one WAV) and `synthesiseStream()`
 * (yields each frame immediately, for a caller that wants to relay audio to
 * a listener as it is generated instead of waiting for the whole clip).
 *
 * Streaming (`streamGenerateContent?alt=sse`) beats the plain `generateContent`
 * call on both ends: the first audio bytes land in low hundreds of ms instead
 * of several seconds, and the full clip finishes sooner too, since generation
 * and network transfer overlap instead of happening one after the other.
 * Measured against production: ~570ms to first byte / ~2.6s total, versus
 * ~3.7-4.4s before any bytes at all arrive on the non-streaming call.
 *
 * Each SSE frame carries a new, disjoint slice of PCM to append — not the
 * full audio so far — confirmed by inspecting raw frames (2026-08-21: 137
 * frames of 1920 bytes each for one sentence, terminated by a frame with no
 * inlineData and finishReason: STOP). Concatenating in arrival order
 * reproduces exactly what the non-streaming call returns in one shot.
 *
 * Streaming is officially supported from gemini-3.1-flash-tts-preview
 * onward; older TTS models still accept `streamGenerateContent`, they just
 * hand back the whole clip as one frame, which this loop handles the same
 * way. Google's own preview notes report the SSE endpoint truncating audio
 * past ~60s (`finishReason: OTHER`) — not a concern here since each call
 * synthesises one sentence-sized chunk, but worth remembering if chunking
 * ever changes to merge many sentences into one clip.
 */
async function* rawSseFrames(text) {
  const cfg = config();
  if (!cfg.apiKey) throw Object.assign(new Error('Gemini is not configured'), { code: 'NOT_CONFIGURED' });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let response;
  try {
    response = await fetch(`${API_BASE}/models/${encodeURIComponent(cfg.modelId)}:streamGenerateContent?alt=sse`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        // Header rather than the documented `?key=` query parameter: a secret in
        // a URL leaks into access logs, proxies and browser history.
        'x-goog-api-key': cfg.apiKey,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: buildPrompt(text) }] }],
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: cfg.voiceId } },
          },
        },
      }),
    });
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') {
      throw Object.assign(new Error(`Gemini TTS timed out after ${TIMEOUT_MS}ms`), { code: 'TIMEOUT' });
    }
    throw Object.assign(new Error(`Gemini unreachable: ${err.message}`), { code: 'NETWORK' });
  }

  if (!response.ok) {
    clearTimeout(timer);
    const body = await response.text().catch(() => '');
    const err = new Error(`Gemini TTS returned ${response.status}${body ? `: ${body.slice(0, 300)}` : ''}`);
    err.code =
      response.status === 400 || response.status === 403 ? 'BAD_KEY'
      : response.status === 404 ? 'BAD_MODEL'
      : response.status === 429 ? 'RATE_LIMIT'
      : 'UPSTREAM';
    err.status = response.status;
    throw err;
  }

  let framesYielded = 0;
  let blockReason = null;

  try {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE frames are separated by a blank line; the last split element is
      // held back as it may be a frame the stream hasn't finished sending yet.
      const frames = buffer.split(/\r?\n\r?\n/);
      buffer = frames.pop();

      for (const frame of frames) {
        const dataLine = frame.split(/\r?\n/).find((line) => line.startsWith('data:'));
        if (!dataLine) continue;
        const json = JSON.parse(dataLine.slice(5).trim());
        const part = json?.candidates?.[0]?.content?.parts?.find((p) => p.inlineData);
        if (part) {
          framesYielded += 1;
          yield { pcm: Buffer.from(part.inlineData.data, 'base64'), mimeType: part.inlineData.mimeType };
        } else if (!blockReason) {
          blockReason = json?.candidates?.[0]?.finishReason === 'STOP'
            ? null
            : json?.candidates?.[0]?.finishReason || json?.promptFeedback?.blockReason || null;
        }
      }
    }
  } catch (err) {
    if (err.name === 'AbortError') {
      throw Object.assign(new Error(`Gemini TTS timed out after ${TIMEOUT_MS}ms`), { code: 'TIMEOUT' });
    }
    throw Object.assign(new Error(`Gemini TTS stream failed: ${err.message}`), { code: 'NETWORK' });
  } finally {
    clearTimeout(timer);
  }

  if (!framesYielded) {
    // A safety block or an empty candidate lands here rather than crashing on
    // undefined, so the caller can fall back to the browser voice.
    throw Object.assign(
      new Error(`Gemini TTS returned no audio${blockReason ? ` (${blockReason})` : ''}`),
      { code: 'UPSTREAM' },
    );
  }
}

/**
 * @param {string} text
 * @returns {Promise<{audio: Buffer, mimeType: string, alignment: null, provider: string, voiceId: string, modelId: string}>}
 */
async function synthesise(text) {
  const cfg = config();
  const pcmParts = [];
  let mimeType = null;
  for await (const frame of rawSseFrames(text)) {
    pcmParts.push(frame.pcm);
    mimeType = frame.mimeType;
  }

  const pcm = Buffer.concat(pcmParts);
  const format = parseAudioFormat(mimeType);

  return {
    audio: pcmToWav(pcm, format),
    mimeType: 'audio/wav',
    alignment: null, // Gemini returns no timings.
    provider: PROVIDER,
    voiceId: cfg.voiceId,
    modelId: cfg.modelId,
  };
}

/**
 * The progressive twin of `synthesise()`: yields each PCM frame the moment
 * it arrives, decoded and tagged with its audio format, instead of waiting
 * for the whole clip. Lets a caller relay audio to a listener as it is
 * generated — the point of streaming synthesis in the first place — rather
 * than buffering the entire response server-side first, which throws away
 * most of the latency win streaming would otherwise give.
 *
 * @param {string} text
 * @yields {{pcm: Buffer, sampleRate: number, channels: number, bitsPerSample: number, provider: string, voiceId: string, modelId: string}}
 */
async function* synthesiseStream(text) {
  const cfg = config();
  let format = null;
  for await (const frame of rawSseFrames(text)) {
    // The format is reported on every frame but is constant for the whole
    // clip — parse it once, not per frame.
    if (!format) format = parseAudioFormat(frame.mimeType);
    yield { pcm: frame.pcm, ...format, provider: PROVIDER, voiceId: cfg.voiceId, modelId: cfg.modelId };
  }
}

/** Confirms the key and model work, by asking for one word of audio. */
async function check() {
  const cfg = config();
  if (!cfg.apiKey) return { configured: false, ok: false, reason: 'no api key' };

  try {
    const result = await synthesise('Hello.');
    return {
      configured: true,
      ok: true,
      provider: PROVIDER,
      voiceId: cfg.voiceId,
      modelId: cfg.modelId,
      bytes: result.audio.length,
    };
  } catch (err) {
    return { configured: true, ok: false, provider: PROVIDER, voiceId: cfg.voiceId, reason: err.message };
  }
}

module.exports = {
  PROVIDER,
  PLACEHOLDER_KEY,
  buildPrompt,
  config,
  isConfigured,
  synthesise,
  synthesiseStream,
  check,
  pcmToWav,
  wavHeader,
  parseAudioFormat,
  DEFAULT_VOICE,
  DEFAULT_MODEL,
};

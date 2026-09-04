'use strict';

/**
 * ElevenLabs text-to-speech provider.
 *
 * Kept alongside Gemini because it is the route to a *cloned* voice — the one
 * thing Gemini's prebuilt voices cannot do. Select with TTS_PROVIDER=elevenlabs.
 *
 * Its distinguishing feature is character-level timings, which let the on-screen
 * text land on the exact syllable being spoken. Gemini returns no timings.
 */

const API_BASE = 'https://api.elevenlabs.io/v1';
const PROVIDER = 'elevenlabs';

// 21m00Tcm4TlvDq8ikWAM is "Rachel", one of ElevenLabs' stock voices. It is a
// real, working id — a placeholder that will actually speak once a key is set.
// Replace with a cloned voice id to make the agent sound like its subject.
const DEFAULT_VOICE_ID = '21m00Tcm4TlvDq8ikWAM';
const DEFAULT_MODEL_ID = 'eleven_turbo_v2_5';
const OUTPUT_FORMAT = 'mp3_44100_128';
const TIMEOUT_MS = Number(process.env.ELEVENLABS_TIMEOUT_MS) || 20_000;

function config() {
  return {
    provider: PROVIDER,
    apiKey: (process.env.ELEVENLABS_API_KEY || '').trim(),
    voiceId: (process.env.ELEVENLABS_VOICE_ID || DEFAULT_VOICE_ID).trim(),
    modelId: (process.env.ELEVENLABS_MODEL_ID || DEFAULT_MODEL_ID).trim(),
  };
}

function isConfigured() {
  return Boolean(config().apiKey);
}

/**
 * Synthesise speech with character-level timings.
 *
 * The `with-timestamps` endpoint returns the alignment alongside the audio,
 * which is what lets the on-screen text track the voice exactly instead of
 * being paced by a guess. If the endpoint is unavailable the caller still gets
 * audio; only the alignment is lost.
 *
 * @returns {Promise<{audio: Buffer, alignment: object|null, voiceId: string, modelId: string}>}
 */
async function synthesise(text) {
  const cfg = config();
  if (!cfg.apiKey) throw Object.assign(new Error('ElevenLabs is not configured'), { code: 'NOT_CONFIGURED' });

  const url = `${API_BASE}/text-to-speech/${encodeURIComponent(cfg.voiceId)}/with-timestamps?output_format=${OUTPUT_FORMAT}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'xi-api-key': cfg.apiKey,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({
        text,
        model_id: cfg.modelId,
        voice_settings: {
          stability: Number(process.env.ELEVENLABS_STABILITY ?? 0.5),
          similarity_boost: Number(process.env.ELEVENLABS_SIMILARITY ?? 0.75),
          style: Number(process.env.ELEVENLABS_STYLE ?? 0),
          use_speaker_boost: true,
        },
      }),
    });
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') {
      throw Object.assign(new Error(`ElevenLabs timed out after ${TIMEOUT_MS}ms`), { code: 'TIMEOUT' });
    }
    throw Object.assign(new Error(`ElevenLabs unreachable: ${err.message}`), { code: 'NETWORK' });
  }
  clearTimeout(timer);

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    const detail = body.slice(0, 300);
    const err = new Error(`ElevenLabs returned ${response.status}${detail ? `: ${detail}` : ''}`);
    // 401 bad key, 422 bad voice id — both are configuration problems worth
    // separating from a transient failure.
    err.code = response.status === 401 ? 'BAD_KEY' : response.status === 422 ? 'BAD_REQUEST' : 'UPSTREAM';
    err.status = response.status;
    throw err;
  }

  const payload = await response.json();
  if (!payload.audio_base64) {
    throw Object.assign(new Error('ElevenLabs response had no audio'), { code: 'UPSTREAM' });
  }

  return {
    audio: Buffer.from(payload.audio_base64, 'base64'),
    mimeType: 'audio/mpeg',
    // `alignment` maps to the characters we sent; `normalized_alignment` maps
    // to ElevenLabs' normalised form, which no longer lines up with our text.
    alignment: payload.alignment || null,
    provider: PROVIDER,
    voiceId: cfg.voiceId,
    modelId: cfg.modelId,
  };
}

/** Confirms the key works and the voice id exists. Used by /api/health. */
async function check() {
  const cfg = config();
  if (!cfg.apiKey) return { configured: false, ok: false, reason: 'no api key' };

  try {
    const response = await fetch(`${API_BASE}/voices/${encodeURIComponent(cfg.voiceId)}`, {
      headers: { 'xi-api-key': cfg.apiKey },
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) {
      return { configured: true, ok: false, voiceId: cfg.voiceId, reason: `voice lookup returned ${response.status}` };
    }
    const voice = await response.json();
    return { configured: true, ok: true, voiceId: cfg.voiceId, voiceName: voice.name, modelId: cfg.modelId };
  } catch (err) {
    return { configured: true, ok: false, voiceId: cfg.voiceId, reason: err.message };
  }
}

module.exports = { PROVIDER, config, isConfigured, synthesise, check, DEFAULT_VOICE_ID, DEFAULT_MODEL_ID };

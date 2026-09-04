'use strict';

/**
 * Speech provider selection.
 *
 * The API key never leaves the server — the browser asks this server for audio,
 * and this server decides whether to synthesise it, serve it from cache, or
 * refuse. When nothing is configured, every call reports "not configured" and
 * the client falls back to the browser's own speech synthesis, so the app is
 * always able to answer out loud.
 */

const crypto = require('node:crypto');

const gemini = require('./gemini');
const elevenlabs = require('./elevenlabs');

const PROVIDERS = { gemini, elevenlabs };

/**
 * Picks the provider. Explicit TTS_PROVIDER wins; otherwise whichever key is
 * present, preferring Gemini since it is the current default engine.
 */
function activeProvider() {
  const requested = (process.env.TTS_PROVIDER || '').trim().toLowerCase();

  if (requested === 'none') return null;
  if (requested && PROVIDERS[requested]) return PROVIDERS[requested];
  if (requested) {
    console.error(`[tts] unknown TTS_PROVIDER "${requested}", falling back to auto-detect`);
  }

  if (gemini.isConfigured()) return gemini;
  if (elevenlabs.isConfigured()) return elevenlabs;
  return null;
}

function config() {
  const provider = activeProvider();
  if (!provider) return { provider: 'none', apiKey: '', voiceId: null, modelId: null };
  return provider.config();
}

function isConfigured() {
  const provider = activeProvider();
  return Boolean(provider && provider.isConfigured());
}

/**
 * Cache key.
 *
 * The provider is part of it because two engines produce entirely different
 * audio for the same text — without it, switching engines would keep serving
 * the old voice from cache and look like the change had not taken effect.
 */
function cacheKey(text, { provider, voiceId, modelId, style }) {
  return crypto
    .createHash('sha256')
    .update(`${provider}|${voiceId}|${modelId}|${style || ''}|${text}`)
    .digest('hex');
}

async function synthesise(text) {
  const provider = activeProvider();
  if (!provider) throw Object.assign(new Error('No speech provider configured'), { code: 'NOT_CONFIGURED' });
  return provider.synthesise(text);
}

async function check() {
  const provider = activeProvider();
  if (!provider) return { configured: false, ok: false, provider: 'none', reason: 'no provider configured' };
  return provider.check();
}

module.exports = { config, isConfigured, cacheKey, synthesise, check, activeProvider, PROVIDERS };

'use strict';

/**
 * Generates the same sentence in several Gemini voices so you can listen and pick.
 *
 * Gemini ships 30 prebuilt voices and documents none of their genders — only a
 * manner ("Charon — informative", "Orus — firm"). There is no way to choose a
 * male voice by reading the docs, so this writes WAV files you can play.
 *
 *   node tools/voice-samples.js
 *   node tools/voice-samples.js --voices Charon,Orus --out ./samples
 *   node tools/voice-samples.js --text "Ask me anything about my work."
 *
 * Then set the winner as GEMINI_TTS_VOICE.
 */

require('../lib/env').load();

const fs = require('node:fs');
const path = require('node:path');

const gemini = require('../lib/tts/gemini');

// Candidates whose descriptors suggest a lower or firmer read. Unverified —
// that is the entire point of listening.
const DEFAULT_VOICES = ['Charon', 'Orus', 'Fenrir', 'Iapetus', 'Enceladus', 'Algieba', 'Puck', 'Rasalgethi'];

const DEFAULT_TEXT =
  "I'm Shridhar. I build products, and I stay close enough to the engineering to actually make them. " +
  'Most of my work has been on AI systems at consumer scale.';

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index !== -1 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

async function main() {
  if (!gemini.isConfigured()) {
    console.error('GEMINI_API_KEY is not set. Add it to .env or export it, then run again.');
    process.exitCode = 1;
    return;
  }

  const voices = arg('voices', DEFAULT_VOICES.join(',')).split(',').map((v) => v.trim()).filter(Boolean);
  const text = arg('text', DEFAULT_TEXT);
  const outDir = path.resolve(arg('out', path.join(__dirname, '..', 'voice-samples')));

  fs.mkdirSync(outDir, { recursive: true });

  console.log(`Model: ${gemini.config().modelId}`);
  console.log(`Output: ${outDir}\n`);

  for (const voice of voices) {
    process.env.GEMINI_TTS_VOICE = voice;
    const label = voice.padEnd(14);

    try {
      const started = Date.now();
      const result = await gemini.synthesise(text);
      const file = path.join(outDir, `${voice}.wav`);
      fs.writeFileSync(file, result.audio);
      console.log(`${label} ok   ${(result.audio.length / 1024).toFixed(0)}KB  ${Date.now() - started}ms  ${file}`);
    } catch (err) {
      console.log(`${label} FAIL ${err.code || 'ERROR'}: ${err.message.split('\n')[0]}`);
    }
  }

  console.log('\nPlay them, pick one, then set it:');
  console.log('  GEMINI_TTS_VOICE=<name>            # locally, in .env');
  console.log('  railway variables --service voice-kb-app --set "GEMINI_TTS_VOICE=<name>"');
  console.log('\nOn macOS:  afplay voice-samples/Charon.wav');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

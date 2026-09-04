/**
 * Turns a raw speech-recognition transcript into something worth sending to
 * the backend. Speech engines emit filler, no punctuation, and the odd
 * self-correction, so this trims the noise before the network call.
 */
(function (global) {
  'use strict';

  const FILLERS = [
    'um', 'uh', 'erm', 'hmm', 'like i mean', 'you know', 'i mean',
    'basically', 'actually', 'sort of', 'kind of',
  ];

  // Wake-style prefixes people add out of habit when talking to a machine.
  const PREFIXES = [
    'hey', 'hi', 'hello', 'ok', 'okay', 'so', 'well', 'please',
    'can you tell me', 'could you tell me', 'i want to know', 'i wanted to know',
    'tell me', 'question', 'quick question',
  ];

  const QUESTION_STARTERS = [
    'what', 'when', 'where', 'who', 'why', 'how', 'which', 'is', 'are', 'do',
    'does', 'did', 'can', 'could', 'should', 'would', 'will',
  ];

  function stripFillers(text) {
    let out = text;
    for (const filler of FILLERS) {
      out = out.replace(new RegExp(`(^|\\s)${filler}(\\s|$)`, 'gi'), ' ');
    }
    return out;
  }

  function stripPrefixes(text) {
    let out = text;
    let changed = true;
    // Repeat so "so, ok, what is pricing" collapses fully.
    while (changed) {
      changed = false;
      for (const prefix of PREFIXES) {
        const re = new RegExp(`^${prefix}\\b[,\\s]*`, 'i');
        if (re.test(out)) {
          out = out.replace(re, '');
          changed = true;
        }
      }
    }
    return out;
  }

  function collapse(text) {
    return text.replace(/\s+/g, ' ').trim();
  }

  /**
   * Drop restarts: "the the cost", and "how much how much does it cost".
   * Speakers back up and re-run the first few words far more often than they
   * repeat something mid-sentence, so only leading phrases are collapsed.
   */
  function dedupeStutter(text) {
    let words = text.split(' ');

    // Adjacent single-word repeats, anywhere.
    const out = [];
    for (const word of words) {
      if (out.length && out[out.length - 1].toLowerCase() === word.toLowerCase()) continue;
      out.push(word);
    }
    words = out;

    // Repeated leading phrase, longest window first.
    for (let size = Math.min(5, Math.floor(words.length / 2)); size >= 2; size -= 1) {
      const head = words.slice(0, size).join(' ').toLowerCase();
      const next = words.slice(size, size * 2).join(' ').toLowerCase();
      if (head === next) {
        words = words.slice(size);
        size = Math.min(5, Math.floor(words.length / 2)) + 1; // restart the scan
      }
    }

    return words.join(' ');
  }

  function capitalise(text) {
    if (!text) return text;
    return text[0].toUpperCase() + text.slice(1);
  }

  function isQuestion(text) {
    return QUESTION_STARTERS.includes(text.split(' ')[0].toLowerCase());
  }

  function punctuate(text, question) {
    if (!text || /[.?!]$/.test(text)) return text;
    return text + (question ? '?' : '.');
  }

  /**
   * @param {string} raw transcript straight off the recogniser
   * @returns {{ raw: string, display: string, question: string, ok: boolean, reason?: string }}
   *   `display` is what the speaker said, tidied for the screen.
   *   `question` is the stripped-down form sent to the backend.
   */
  function parseTranscript(raw) {
    const source = String(raw || '').trim();
    const lowered = collapse(source.toLowerCase());

    if (!lowered) return { raw: source, display: '', question: '', ok: false, reason: 'empty' };

    let text = collapse(stripFillers(lowered));
    text = collapse(dedupeStutter(text));
    const cleaned = text;

    // Only drop the wake-style prefix if enough of the question survives it.
    const stripped = collapse(stripPrefixes(cleaned));
    if (stripped.split(' ').length >= 3) text = stripped;

    if (!text || text.replace(/[^a-z0-9]/g, '').length < 2) {
      return { raw: source, display: '', question: '', ok: false, reason: 'too-short' };
    }

    // The stripped form decides the punctuation for both: "hey how much is it"
    // is a question even though the filler in front of it isn't.
    const asking = isQuestion(text);

    return {
      raw: source,
      display: punctuate(capitalise(cleaned), asking),
      question: punctuate(capitalise(text), asking),
      ok: true,
    };
  }

  global.VoiceParse = { parseTranscript };
})(window);

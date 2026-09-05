/**
 * Voice in → parsed transcript → backend knowledge base → voice out, typed on
 * screen in sync with the spoken audio.
 */
(function () {
  'use strict';

  // ?debug=1 exposes match confidence and the rewritten query. Off by default:
  // whoever is asking the questions does not need to see the plumbing.
  const DEBUG = new URLSearchParams(location.search).has('debug');

  const el = {
    body: document.body,
    stage: document.getElementById('stage'),
    emptyState: document.getElementById('empty-state'),
    brandName: document.getElementById('brand-name'),
    greeting: document.getElementById('greeting'),
    subGreeting: document.getElementById('sub-greeting'),
    answerLabel: document.getElementById('answer-label'),
    exchange: document.getElementById('exchange'),
    questionText: document.getElementById('question-text'),
    parsedNote: document.getElementById('parsed-note'),
    answerTyped: document.getElementById('answer-typed'),
    caret: document.getElementById('caret'),
    detailToggle: document.getElementById('detail-toggle'),
    detailText: document.getElementById('detail-text'),
    sourceChip: document.getElementById('source-chip'),
    liveTranscript: document.getElementById('live-transcript'),
    mic: document.getElementById('mic'),
    resetBtn: document.getElementById('reset-btn'),
    status: document.getElementById('status'),
    badge: document.getElementById('kb-badge'),
    muteToggle: document.getElementById('mute-toggle'),
    muteIconOn: document.getElementById('mute-icon-on'),
    muteIconOff: document.getElementById('mute-icon-off'),
    keyboardToggle: document.getElementById('keyboard-toggle'),
    fallbackForm: document.getElementById('fallback-form'),
    fallbackInput: document.getElementById('fallback-input'),
  };

  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  const synth = window.speechSynthesis;

  let state = 'idle'; // idle | listening | thinking | speaking
  let recognition = null;
  let muted = localStorage.getItem('voicekb:muted') === '1';
  let finalTranscript = '';
  let activeTypewriter = null;
  // Armed by the first mic tap of a visit, not persisted — once on, the mic
  // reopens on its own after each answer (and after an interruption) so a
  // back-and-forth conversation needs no further taps. A tap while actively
  // listening turns it back off; that is the explicit "I'm done for now".
  let conversationMode = false;
  // How many times in a row the mic has heard nothing since the last real
  // transcript. Capped so a silent room (or a visitor who walked away) does
  // not leave the mic re-opening forever.
  let noSpeechRetries = 0;
  const MAX_NO_SPEECH_RETRIES = 2;
  // 'server' when the backend has a speech provider configured, 'browser'
  // otherwise. Never mutated on failure — a transient blip must not
  // permanently silence the real voice for the rest of the session; each
  // answer gets its own fresh attempt.
  let voiceProvider = 'browser';
  let currentAudio = null;
  let micStream = null;
  let audioUnlocked = false;
  let playbackAudio = null;

  /**
   * The single <audio> element every server-voice answer plays through.
   *
   * Reused rather than a fresh `new Audio()` per answer for two reasons: an
   * autoplay unlock granted to one element instance does not reliably carry
   * to a different one created later on strict mobile browsers, and the Web
   * Audio API only allows `createMediaElementSource` to be called once per
   * element — reusing one element is what lets the orb's playback analyser
   * (see Orb.attachPlayback) stay wired across every answer instead of
   * throwing on the second one.
   */
  function getPlaybackAudio() {
    if (!playbackAudio) {
      playbackAudio = new Audio();
      playbackAudio.preload = 'auto';
    }
    return playbackAudio;
  }

  /**
   * Some engines (iOS Safari especially) only let `audio.play()` and
   * `speechSynthesis.speak()` actually produce sound when the call happens
   * inside the same task as a user gesture. Every real answer's audio is
   * created later, after an async fetch — well outside that window — so both
   * APIs go silently inert the moment the code leaves the click handler.
   *
   * Playing something (silently) synchronously inside the tap unlocks both
   * APIs for the rest of the page's life. Call this from every gesture that
   * can lead to speak() — never from inside an async continuation, or it
   * does nothing.
   */
  function unlockAudio() {
    if (audioUnlocked) return;
    audioUnlocked = true;

    // Two independent unlock mechanisms, since they gate different browser
    // subsystems and a failure in one does not predict the other. The Web
    // Audio buffer has no network fetch and no container format to reject,
    // so it is the more reliable of the two.
    if (window.Orb) Orb.playSilentBuffer();

    try {
      // Play (and immediately pause) THIS SAME element that every real
      // answer will later reuse — some mobile browsers tie the autoplay
      // unlock to the specific element instance played during the gesture,
      // not to the page as a whole, so a throwaway Audio() created here
      // wouldn't unlock the different Audio() a later async answer creates.
      const audio = getPlaybackAudio();
      audio.src = '/silence.wav';
      audio.load();
      audio.play().then(() => audio.pause()).catch(() => {});
    } catch {
      /* best-effort unlock; a real answer's own play() will surface any real problem */
    }

    try {
      if (synth) {
        const warm = new SpeechSynthesisUtterance(' ');
        warm.volume = 0;
        synth.speak(warm);
      }
    } catch {
      /* nothing to unlock without speechSynthesis */
    }
  }

  /* ---------------- state ---------------- */

  function setState(next, message) {
    const prev = state;
    state = next;
    el.body.dataset.state = next;
    if (message !== undefined) setStatus(message);
    el.mic.setAttribute('aria-label', next === 'listening' ? 'Stop listening' : 'Start listening');

    if (window.Orb) Orb.setMode(next);
    // The orb's mic teardown only disconnects the Web Audio graph; the
    // getUserMedia stream itself is owned here and must be stopped
    // separately, or the browser's mic-in-use indicator never clears.
    if (prev === 'listening' && next !== 'listening') stopMicVisualizer();
    if (next === 'speaking' && prev !== 'speaking') startBargeInMonitor();
    if (prev === 'speaking' && next !== 'speaking') stopBargeInMonitor();
  }

  /**
   * Runs a second, independent getUserMedia purely so the orb has real audio
   * to react to — the Web Speech API captures its own audio internally but
   * never exposes it. If the user declines this second prompt (or the
   * permission dialog is suppressed), the orb falls back to a synthetic
   * pulse rather than sitting still.
   */
  async function startMicVisualizer() {
    if (!window.Orb) return;
    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (state !== 'listening') {
        // Listening ended before the permission prompt resolved.
        micStream.getTracks().forEach((t) => t.stop());
        micStream = null;
        return;
      }
      Orb.attachMic(micStream);
    } catch {
      if (state === 'listening') Orb.useSyntheticPulse(0.22, 0.06);
    }
  }

  function stopMicVisualizer() {
    if (micStream) {
      micStream.getTracks().forEach((t) => t.stop());
      micStream = null;
    }
    if (window.Orb) Orb.detachMic();
  }

  /* ---------------- barge-in ---------------- */

  // A third, independent getUserMedia stream (separate from the listening
  // mic and the orb's visualizer) that only watches for volume, never
  // transcribes. It runs while an answer is playing so a visitor can start
  // talking over it and be heard, the way an actual conversation works,
  // instead of needing to tap the mic first. Kept separate from the orb's
  // own analyser graph so it does not fight the playback visualizer for the
  // same levelSource.
  let bargeInStream = null;
  let bargeInAnalyser = null;
  let bargeInData = null;
  let bargeInRaf = null;
  let bargeInAboveSince = null;

  // A fixed volume threshold does not work here: `echoCancellation: true` on
  // getUserMedia is built for WebRTC call audio, and on plenty of real
  // devices (mobile Safari especially) it does nothing at all for a plain
  // <audio> element's output — confirmed live: the very first version of
  // this used a fixed level and self-interrupted the instant the answer
  // started speaking, every time, on a real phone. The fix is to stop
  // guessing a number and instead measure OUR OWN output level in real time
  // (Orb.getPlaybackLevel(), the same analyser already driving the orb's
  // visual pulse) and require the mic to read meaningfully louder than that,
  // not just louder than a constant. When we go quiet between words the bar
  // drops with it, so a genuine interruption in a natural pause is still
  // caught quickly; while we are speaking loudly the bar rises with it, so
  // our own bleed-through has to actually beat what it would take to be
  // heard over ourselves.
  const BARGE_IN_BASE = 0.1; // floor so background noise cannot trigger during a silent gap
  const BARGE_IN_ECHO_MARGIN = 1.7; // mic must read this many times our own current output
  const BARGE_IN_HOLD_MS = 320; // sustained, not a single loud frame — filters a cough or a tap sound

  async function startBargeInMonitor() {
    if (!conversationMode || !SpeechRecognition || bargeInStream) return;
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch {
      // No mic access for this purpose — barge-in just never fires; a tap
      // still interrupts the answer same as before.
      return;
    }
    if (state !== 'speaking' || !window.Orb) {
      // The answer finished (or was interrupted some other way) before the
      // permission prompt resolved.
      stream.getTracks().forEach((t) => t.stop());
      return;
    }

    const audioCtx = Orb.ensureContext();
    if (!audioCtx) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }

    bargeInStream = stream;
    const source = audioCtx.createMediaStreamSource(bargeInStream);
    bargeInAnalyser = audioCtx.createAnalyser();
    bargeInAnalyser.fftSize = 256;
    bargeInAnalyser.smoothingTimeConstant = 0.6;
    source.connect(bargeInAnalyser);
    bargeInData = new Uint8Array(bargeInAnalyser.frequencyBinCount);
    bargeInAboveSince = null;
    // The playback analyser can take a frame or two to attach after speaking
    // starts, which would read as 0 right as the loudest part of the answer
    // (its opening) attacks — a false huge ratio in that split second. Wait
    // for things to settle before evaluating anything.
    const armedAt = performance.now() + 300;

    const tick = () => {
      if (!bargeInAnalyser) return; // stopBargeInMonitor() already ran
      bargeInAnalyser.getByteFrequencyData(bargeInData);
      let sum = 0;
      for (let i = 0; i < bargeInData.length; i += 1) sum += bargeInData[i];
      const level = Math.min(1, sum / bargeInData.length / 70);

      const playbackLevel = Orb.getPlaybackLevel();
      const dynamicThreshold = BARGE_IN_BASE + playbackLevel * BARGE_IN_ECHO_MARGIN;

      if (performance.now() >= armedAt && level >= dynamicThreshold) {
        if (bargeInAboveSince === null) {
          bargeInAboveSince = performance.now();
        } else if (performance.now() - bargeInAboveSince >= BARGE_IN_HOLD_MS) {
          stopBargeInMonitor();
          // The visitor is already mid-sentence by the time this fires —
          // open the real mic immediately rather than after the usual
          // pause, or the start of what they are saying gets clipped.
          interruptSpeaking({ listenImmediately: true });
          return;
        }
      } else {
        bargeInAboveSince = null;
      }
      bargeInRaf = requestAnimationFrame(tick);
    };
    bargeInRaf = requestAnimationFrame(tick);
  }

  function stopBargeInMonitor() {
    if (bargeInRaf) cancelAnimationFrame(bargeInRaf);
    bargeInRaf = null;
    bargeInAnalyser = null;
    bargeInData = null;
    bargeInAboveSince = null;
    if (bargeInStream) {
      bargeInStream.getTracks().forEach((t) => t.stop());
      bargeInStream = null;
    }
  }

  function setStatus(message, isError = false) {
    el.status.textContent = message;
    el.status.classList.toggle('error', isError);
  }

  /* ---------------- typewriter, synced to speech ---------------- */

  function stopTypewriter(complete = true) {
    if (!activeTypewriter) return;
    activeTypewriter.cancel(complete);
    activeTypewriter = null;
  }

  /**
   * Types `text` into the answer node.
   *
   * `chars()` is the progress source: it returns how many characters have
   * actually been spoken. ElevenLabs gives real character timings and the audio
   * element gives real playback position, so with that the text tracks the
   * voice exactly. Without it the typewriter falls back to a rate estimate,
   * which browser speech nudges forward via `boundary` events.
   */
  function startTypewriter(text, { estimatedMs = 3000, chars = null } = {}) {
    stopTypewriter();
    el.caret.hidden = false;

    // Mutable: when the answer is streamed, the text grows while it types.
    let fullText = text;

    const started = performance.now();
    const charsPerMs = Math.max(text.length, 1) / Math.max(estimatedMs, 400);
    let spokenFloor = 0;
    let frame = null;
    let done = false;

    function finish() {
      done = true;
      if (frame) cancelAnimationFrame(frame);
      el.answerTyped.textContent = fullText;
      el.caret.hidden = true;
    }

    function tick() {
      if (done) return;

      let index;
      if (chars) {
        const reported = chars();
        // null means "not playing yet" — hold rather than jumping to zero.
        index = reported === null ? el.answerTyped.textContent.length : reported;
      } else {
        const elapsed = performance.now() - started;
        index = Math.max(Math.floor(elapsed * charsPerMs), spokenFloor);
      }

      index = Math.min(fullText.length, Math.max(index, 0));
      el.answerTyped.textContent = fullText.slice(0, index);
      el.stage.scrollTop = el.stage.scrollHeight;

      // While streaming, reaching the end of what has arrived is not the end of
      // the answer — keep the loop alive until the caller says it is complete.
      if (index >= fullText.length && !streaming) {
        el.caret.hidden = true;
        done = true;
        return;
      }
      frame = requestAnimationFrame(tick);
    }

    let streaming = false;
    frame = requestAnimationFrame(tick);

    activeTypewriter = {
      /** Called from the speech `boundary` event so text never lags the audio. */
      syncTo(charIndex, charLength) {
        spokenFloor = Math.min(fullText.length, charIndex + (charLength || 0));
      },
      /** Extends the text mid-flight, for answers that arrive a token at a time. */
      setText(next, { more = false } = {}) {
        fullText = next;
        streaming = more;
        if (done && more) {
          done = false;
          frame = requestAnimationFrame(tick);
        }
      },
      cancel(complete) {
        if (complete) finish();
        else {
          done = true;
          if (frame) cancelAnimationFrame(frame);
          el.caret.hidden = true;
        }
      },
    };
  }

  /* ---------------- speech out ---------------- */

  function estimateDuration(text) {
    const words = text.trim().split(/\s+/).length;
    return (words / 2.7) * 1000 + 350; // ~2.7 words per second, plus a beat of lead-in
  }

  /**
   * Speaks `text`, preferring the server's ElevenLabs voice and falling back to
   * whatever the browser can do. Either way the typewriter runs alongside.
   */
  /**
   * @param {string} text
   * @param {string} speechToken proof this server produced the text
   * @param {{typewriter?: boolean}} options `typewriter: false` when the text is
   *   already on screen from streaming — restarting it would rewind the answer.
   */
  async function speak(text, speechToken, { typewriter = true } = {}) {
    if (muted) {
      const estimated = estimateDuration(text);
      if (typewriter) startTypewriter(text, { estimatedMs: estimated });
      // No audio at all, but the orb should still visibly "speak" rather than
      // sit inert — a muted answer is still an answer being given.
      if (window.Orb) Orb.useSyntheticPulse(0.2, 0.07);
      await new Promise((resolve) => setTimeout(resolve, estimated));
      return;
    }

    if (voiceProvider === 'server') {
      try {
        await speakWithServer(text, speechToken, typewriter);
        return;
      } catch (err) {
        // Any failure here — no credit, bad key, a rejected play() on a
        // strict mobile browser — should cost the listener nothing beyond
        // this one answer. Fall back for THIS call only; the next question
        // gets a fresh attempt at the real voice rather than being stuck on
        // the robotic one for the rest of the session.
        console.warn(`[voice] server audio unavailable this time, using browser speech: ${err.name ? err.name + ': ' : ''}${err.message}`);
      }
    }

    await speakWithBrowser(text, typewriter);
  }

  /** Fetches audio from our server, plays it, and drives the typewriter from it. */
  async function speakWithServer(text, speechToken, typewriter = true) {
    const response = await fetch('/api/speak', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, speechToken }),
    });

    if (!response.ok) {
      const detail = await response.json().catch(() => ({}));
      throw new Error(detail.error || `server returned ${response.status}`);
    }

    const data = await response.json();
    const blob = base64ToBlob(data.audioBase64, data.mimeType || 'audio/mpeg');
    const url = URL.createObjectURL(blob);

    const audio = getPlaybackAudio();
    audio.src = url;
    currentAudio = audio;

    // Character timings, when ElevenLabs returned them, let the text land on
    // the exact syllable being spoken.
    const timings = alignmentEndTimes(data.alignment);

    try {
      await new Promise((resolve, reject) => {
        let settled = false;
        const done = (err) => {
          if (settled) return;
          settled = true;
          err ? reject(err) : resolve();
        };

        audio.addEventListener('error', () => done(new Error('audio playback failed')), { once: true });
        audio.addEventListener('ended', () => done(), { once: true });
        // Interrupting (mic tap, mute) pauses rather than ending, and a paused
        // element fires no 'ended' — without this the await would never settle.
        audio.addEventListener('pause', () => done(), { once: true });

        audio.addEventListener(
          'loadedmetadata',
          () => {
            const durationMs = Number.isFinite(audio.duration) ? audio.duration * 1000 : estimateDuration(text);

            if (typewriter) {
              startTypewriter(text, {
                estimatedMs: durationMs,
                chars: () => {
                  if (!audio.currentTime && audio.paused) return null;
                  if (timings) return charsSpokenAt(timings, audio.currentTime);
                  if (!Number.isFinite(audio.duration) || audio.duration === 0) return null;
                  return Math.floor((audio.currentTime / audio.duration) * text.length);
                },
              });
            }

            // Real audio to react to when the browser allows tapping the
            // element; a synthetic pulse when it doesn't (some browsers
            // restrict this outside a fresh gesture) so the orb still moves.
            if (window.Orb && !Orb.attachPlayback(audio)) Orb.useSyntheticPulse(0.26, 0.09);

            audio.play().catch((err) => done(err));
          },
          { once: true },
        );

        audio.load();
      });
    } finally {
      URL.revokeObjectURL(url);
      if (currentAudio === audio) currentAudio = null;
    }
  }

  function base64ToBlob(base64, mimeType) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type: mimeType });
  }

  /** ElevenLabs alignment → a flat array of per-character end times in seconds. */
  function alignmentEndTimes(alignment) {
    if (!alignment) return null;
    const times = alignment.character_end_times_seconds;
    return Array.isArray(times) && times.length ? times : null;
  }

  /** How many characters have finished being spoken at `seconds`. Binary search. */
  function charsSpokenAt(times, seconds) {
    let low = 0;
    let high = times.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (times[mid] <= seconds) low = mid + 1;
      else high = mid;
    }
    return low;
  }

  function speakWithBrowser(text, typewriter = true) {
    return new Promise((resolve) => {
      const estimated = estimateDuration(text);
      if (typewriter) startTypewriter(text, { estimatedMs: estimated });

      if (!synth) {
        setTimeout(resolve, estimated);
        return;
      }

      // speechSynthesis exposes no audio buffer to analyse, so the orb gets a
      // believable synthetic pulse instead of going still while it talks.
      if (window.Orb) Orb.useSyntheticPulse(0.24, 0.08);

      synth.cancel();
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.rate = 1;
      utterance.pitch = 1;
      utterance.lang = 'en-US';

      const preferred = pickVoice();
      if (preferred) utterance.voice = preferred;

      utterance.onboundary = (event) => {
        if (activeTypewriter && typeof event.charIndex === 'number') {
          activeTypewriter.syncTo(event.charIndex, event.charLength || 0);
        }
      };
      utterance.onend = () => resolve();
      utterance.onerror = () => resolve();

      synth.speak(utterance);

      // Safety net: some browsers never fire onend if the tab loses focus.
      setTimeout(resolve, estimated + 4000);
    });
  }

  // Set whenever a multi-chunk answer is interrupted mid-playback. A promise
  // chain has no native "cancel" — without this flag, chunks already queued
  // via `.then()` at the moment of interruption would keep playing one after
  // another in the background even though the UI has already moved on.
  let answerInterrupted = false;

  /** Silences whichever voice is currently talking, and stops any queued chunks. */
  function stopSpeaking() {
    answerInterrupted = true;
    if (synth) synth.cancel();
    if (currentAudio) {
      currentAudio.pause();
      currentAudio.currentTime = 0;
      currentAudio = null;
    }
  }

  function pickVoice() {
    if (!synth) return null;
    const voices = synth.getVoices();
    if (!voices.length) return null;
    const wanted = ['Samantha', 'Google US English', 'Microsoft Aria Online', 'Alex'];
    for (const name of wanted) {
      const match = voices.find((v) => v.name === name);
      if (match) return match;
    }
    return voices.find((v) => v.lang && v.lang.startsWith('en')) || null;
  }

  if (synth) synth.onvoiceschanged = pickVoice;

  /* ---------------- backend ---------------- */

  async function ask(parsed) {
    answerInterrupted = false;
    setState('thinking', 'Searching the knowledge base…');
    el.liveTranscript.textContent = '';

    el.emptyState.hidden = true;
    el.exchange.hidden = false;
    el.questionText.textContent = parsed.display || parsed.question;

    // Make the parsing visible when it actually changed the query.
    const rewritten = DEBUG && parsed.question !== (parsed.display || parsed.question);
    el.parsedNote.textContent = rewritten ? `sent to backend as: ${parsed.question}` : '';
    el.parsedNote.hidden = !rewritten;

    el.answerTyped.textContent = '';
    el.caret.hidden = false;
    el.sourceChip.hidden = true;
    hideDetail();

    try {
      const data = await streamAndSpeakAnswer(parsed);
      // A null result means the answer was interrupted mid-flight (mic tap,
      // reset) — whoever interrupted it already moved the UI on; there is
      // nothing left here to render.
      if (!data) return;
      renderSource(data);
      // Offered up front, collapsed, so it survives the listener interrupting
      // and lets them read along instead of waiting for the audio to finish.
      if (data.detail) showDetailToggle(data.detail);
      setState('idle', conversationMode ? 'Hands-free — listening for your next question…' : 'Tap to ask another question');
      maybeAutoListen();
    } catch (err) {
      if (answerInterrupted) return; // interrupted mid-network-read, not a real error

      stopTypewriter(false);
      el.answerTyped.textContent = '';
      setState('idle');
      setStatus(`Couldn't reach the backend: ${err.message}`, true);
      maybeAutoListen();
    }
  }

  /**
   * Fetches the answer as a stream of sentence-sized chunks, each carrying
   * its own audio, and plays them strictly in the order they arrive.
   *
   * The server used to stream raw LLM tokens for display while separately
   * synthesising the whole finished answer as one audio clip afterward — so
   * the full answer was already on screen, read, before any audio started.
   * Now nothing is shown until the first chunk (and its audio) is ready, and
   * each chunk's text types in step with that chunk's own playback. Earlier
   * chunks stay on screen while later ones are still arriving, so audio for
   * a short first sentence can start almost immediately instead of waiting
   * for the whole answer to generate and then be voiced as a single clip.
   */
  async function streamAndSpeakAnswer(parsed) {
    // A safety net, not a tuning knob: the server's own LLM (6s) and TTS
    // (10s) calls already fail over to a stored answer well inside this
    // window on their own. This only fires if something outside either of
    // those — a hung DB query, a dropped connection — leaves the request
    // open with no bound at all, which would otherwise strand the UI in
    // "thinking"/"speaking" forever with no way back except a manual tap.
    const watchdog = new AbortController();
    const watchdogTimer = setTimeout(() => watchdog.abort(), 25_000);

    let response;
    try {
      response = await fetch('/api/ask', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question: parsed.question, raw: parsed.raw }),
        signal: watchdog.signal,
      });
    } catch (err) {
      clearTimeout(watchdogTimer);
      if (err.name === 'AbortError') throw new Error('That took too long to answer. Try again?');
      throw err;
    }

    if (!response.ok) {
      clearTimeout(watchdogTimer);
      const detail = await response.json().catch(() => ({}));
      throw new Error(detail.error || `Server returned ${response.status}`);
    }

    // A server without streaming support, or an error page, still answers
    // here with the old single-clip behaviour.
    if (!response.body || !/text\/event-stream/.test(response.headers.get('content-type') || '')) {
      clearTimeout(watchdogTimer);
      const data = await response.json();
      setState('speaking', muted ? 'Muted — showing the answer' : 'Answering…');
      await speak(data.answer, data.speechToken);
      stopTypewriter(true);
      return data;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let doneData = null;
    let streamError = null;

    // Each chunk's playback is chained after the previous one, so even if
    // several `chunk` events arrive in a burst (the server can synthesise
    // faster than one chunk plays), they still play strictly in order.
    let revealedPrefix = '';
    let chunkChain = Promise.resolve();
    let sawFirstChunk = false;

    const handle = (event, data) => {
      if (event === 'chunk') {
        if (!sawFirstChunk) {
          sawFirstChunk = true;
          setState('speaking', muted ? 'Muted — showing the answer' : 'Answering…');
        }
        chunkChain = chunkChain.then(async () => {
          // Already-queued chunks must not start playing after the listener
          // interrupted an earlier one — a promise chain has no native cancel.
          if (answerInterrupted) return;
          await playChunk(data, revealedPrefix);
          revealedPrefix += data.text + ' ';
        });
      } else if (event === 'done') {
        doneData = data;
      } else if (event === 'error') {
        streamError = new Error(data.error);
      }
    };

    try {
      while (true) {
        if (answerInterrupted) {
          await reader.cancel().catch(() => {});
          break;
        }

        const { done: finished, value } = await reader.read();
        if (finished) break;

        buffer += decoder.decode(value, { stream: true });

        // Tolerate CRLF as well as LF between frames — our own server writes LF,
        // but a proxy in front of it is free to normalise line endings, and a
        // parser that only matches \n\n would silently drop every event.
        let match;
        while ((match = /\r?\n\r?\n/.exec(buffer)) !== null) {
          const frame = buffer.slice(0, match.index);
          buffer = buffer.slice(match.index + match[0].length);

          let event = 'message';
          let payload = '';
          for (const rawLine of frame.split(/\r?\n/)) {
            const line = rawLine.trimEnd();
            if (line.startsWith('event:')) event = line.slice(6).trim();
            else if (line.startsWith('data:')) payload += line.slice(5).trim();
          }
          if (payload) handle(event, JSON.parse(payload));
        }
      }
    } catch (err) {
      if (err.name === 'AbortError') throw new Error('That took too long to answer. Try again?');
      throw err;
    } finally {
      clearTimeout(watchdogTimer);
    }

    await chunkChain.catch(() => {}); // let every already-queued chunk resolve (or no-op) first

    if (answerInterrupted) return null;
    if (streamError) throw streamError;
    if (!doneData) throw new Error('The answer stream ended early');

    stopTypewriter(true);
    return doneData;
  }

  /**
   * Plays one chunk's audio and types `prefix + chunk.text` in step with it.
   * `prefix` is everything already fully revealed by earlier chunks in this
   * answer — shown instantly, never re-animated.
   */
  async function playChunk(chunk, prefix) {
    const displayText = prefix + chunk.text;

    if (muted) {
      const estimated = estimateDuration(chunk.text);
      const started = performance.now();
      const rate = chunk.text.length / Math.max(estimated, 400);
      startTypewriter(displayText, {
        estimatedMs: estimated,
        chars: () => prefix.length + Math.min(chunk.text.length, Math.floor((performance.now() - started) * rate)),
      });
      if (window.Orb) Orb.useSyntheticPulse(0.2, 0.07);
      await new Promise((resolve) => setTimeout(resolve, estimated));
      return;
    }

    if (voiceProvider === 'server' && chunk.audioBase64) {
      try {
        await playChunkWithServer(chunk, prefix, displayText);
        return;
      } catch (err) {
        console.warn(`[voice] server audio unavailable this time, using browser speech: ${err.name ? err.name + ': ' : ''}${err.message}`);
      }
    }

    await playChunkWithBrowser(chunk, prefix, displayText);
  }

  /** Fetches this chunk's audio from base64, plays it, and syncs the typewriter to it. */
  async function playChunkWithServer(chunk, prefix, displayText) {
    const blob = base64ToBlob(chunk.audioBase64, chunk.mimeType || 'audio/mpeg');
    const url = URL.createObjectURL(blob);

    const audio = getPlaybackAudio();
    audio.src = url;
    currentAudio = audio;

    const timings = alignmentEndTimes(chunk.alignment);

    try {
      await new Promise((resolve, reject) => {
        let settled = false;
        const done = (err) => {
          if (settled) return;
          settled = true;
          err ? reject(err) : resolve();
        };

        audio.addEventListener('error', () => done(new Error('audio playback failed')), { once: true });
        audio.addEventListener('ended', () => done(), { once: true });
        // Interrupting (mic tap, mute) pauses rather than ending, and a paused
        // element fires no 'ended' — without this the await would never settle.
        audio.addEventListener('pause', () => done(), { once: true });

        audio.addEventListener(
          'loadedmetadata',
          () => {
            const durationMs = Number.isFinite(audio.duration) ? audio.duration * 1000 : estimateDuration(chunk.text);

            startTypewriter(displayText, {
              estimatedMs: durationMs,
              chars: () => {
                if (!audio.currentTime && audio.paused) return null;
                if (timings) return prefix.length + charsSpokenAt(timings, audio.currentTime);
                if (!Number.isFinite(audio.duration) || audio.duration === 0) return null;
                return prefix.length + Math.floor((audio.currentTime / audio.duration) * chunk.text.length);
              },
            });

            if (window.Orb && !Orb.attachPlayback(audio)) Orb.useSyntheticPulse(0.26, 0.09);

            audio.play().catch((err) => done(err));
          },
          { once: true },
        );

        audio.load();
      });
    } finally {
      URL.revokeObjectURL(url);
      if (currentAudio === audio) currentAudio = null;
    }
  }

  /** speechSynthesis fallback for one chunk, syncing the typewriter via boundary events. */
  function playChunkWithBrowser(chunk, prefix, displayText) {
    return new Promise((resolve) => {
      const estimated = estimateDuration(chunk.text);
      startTypewriter(displayText, { estimatedMs: estimated });
      if (window.Orb) Orb.useSyntheticPulse(0.24, 0.08);

      if (!synth) {
        setTimeout(resolve, estimated);
        return;
      }

      synth.cancel();
      const utterance = new SpeechSynthesisUtterance(chunk.text);
      utterance.rate = 1;
      utterance.pitch = 1;
      utterance.lang = 'en-US';

      const preferred = pickVoice();
      if (preferred) utterance.voice = preferred;

      utterance.onboundary = (event) => {
        if (activeTypewriter && typeof event.charIndex === 'number') {
          activeTypewriter.syncTo(prefix.length + event.charIndex, event.charLength || 0);
        }
      };
      utterance.onend = () => resolve();
      utterance.onerror = () => resolve();

      synth.speak(utterance);

      // Safety net: some browsers never fire onend if the tab loses focus.
      setTimeout(resolve, estimated + 4000);
    });
  }

  function hideDetail() {
    el.detailToggle.hidden = true;
    el.detailToggle.setAttribute('aria-expanded', 'false');
    el.detailToggle.textContent = 'Read the full story';
    el.detailText.hidden = true;
    el.detailText.textContent = '';
  }

  function showDetailToggle(detail) {
    el.detailToggle.hidden = false;
    el.detailToggle.dataset.detail = detail;
  }

  el.detailToggle.addEventListener('click', () => {
    const expanded = el.detailToggle.getAttribute('aria-expanded') === 'true';

    if (expanded) {
      el.detailText.hidden = true;
      el.detailToggle.setAttribute('aria-expanded', 'false');
      el.detailToggle.textContent = 'Read the full story';
      return;
    }

    // Build paragraphs as nodes rather than innerHTML — this text comes from
    // the database and is never treated as markup.
    el.detailText.textContent = '';
    for (const para of (el.detailToggle.dataset.detail || '').split('\n\n')) {
      if (!para.trim()) continue;
      const p = document.createElement('p');
      p.textContent = para.trim();
      el.detailText.appendChild(p);
    }

    el.detailText.hidden = false;
    el.detailToggle.setAttribute('aria-expanded', 'true');
    el.detailToggle.textContent = 'Hide the full story';
    el.detailText.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });

  function renderSource(data) {
    if (!DEBUG) return;
    if (data.matched && data.source) {
      el.sourceChip.textContent = `${data.source.id} · ${data.via} · ${Math.round(data.confidence * 100)}%`;
      el.sourceChip.classList.remove('miss');
    } else {
      el.sourceChip.textContent = 'no match — fallback';
      el.sourceChip.classList.add('miss');
    }
    el.sourceChip.hidden = false;
  }

  function submitTranscript(raw) {
    noSpeechRetries = 0;
    const parsed = window.VoiceParse.parseTranscript(raw);
    if (!parsed.ok) {
      setState('idle');
      setStatus("I didn't catch that. Try again?", true);
      return;
    }
    ask(parsed);
  }

  /**
   * The mic heard nothing this round. In hands-free mode, quietly reopen it
   * a couple more times — a pause between questions is normal — before
   * giving up and waiting for an explicit tap, so a quiet room doesn't leave
   * the mic listening forever.
   */
  function handleNoSpeech() {
    if (conversationMode && noSpeechRetries < MAX_NO_SPEECH_RETRIES) {
      noSpeechRetries += 1;
      setState('idle');
      setTimeout(() => {
        if (conversationMode && state === 'idle') startListening();
      }, 400);
    } else {
      noSpeechRetries = 0;
      setState('idle', conversationMode ? "Didn't catch anything — tap the mic to keep going" : 'Tap to speak');
    }
  }

  /* ---------------- speech in ---------------- */

  function buildRecognition() {
    const rec = new SpeechRecognition();
    rec.lang = 'en-US';
    rec.interimResults = true;
    rec.continuous = false;
    rec.maxAlternatives = 1;

    rec.onstart = () => {
      finalTranscript = '';
      el.liveTranscript.textContent = '';
      setState('listening', 'Listening — speak now, then pause');
      startMicVisualizer();
    };

    rec.onresult = (event) => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        if (result.isFinal) finalTranscript += result[0].transcript;
        else interim += result[0].transcript;
      }
      el.liveTranscript.textContent = (finalTranscript + interim).trim();
    };

    rec.onerror = (event) => {
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
        conversationMode = false;
        setState('idle');
        setStatus('Microphone blocked. Allow mic access, or type your question.', true);
        showFallbackForm();
      } else if (event.error === 'no-speech') {
        handleNoSpeech();
      } else {
        setState('idle');
        if (event.error !== 'aborted') setStatus(`Speech recognition error: ${event.error}`, true);
      }
    };

    rec.onend = () => {
      if (state !== 'listening') return;
      const transcript = finalTranscript.trim() || el.liveTranscript.textContent.trim();
      if (transcript) submitTranscript(transcript);
      else handleNoSpeech();
    };

    return rec;
  }

  function startListening() {
    if (!recognition) recognition = buildRecognition();
    try {
      recognition.start();
    } catch {
      // start() throws if it is already running; ignore.
    }
  }

  function stopListening() {
    if (recognition) recognition.stop();
  }

  /**
   * Reopens the mic on its own once an answer has actually finished (or been
   * interrupted), when conversation mode is armed. The short delay lets the
   * last bit of audio and the speaker's own echo settle before the mic goes
   * live again, rather than risking it catching the tail of the answer.
   */
  function maybeAutoListen() {
    if (!conversationMode || !SpeechRecognition) return;
    setTimeout(() => {
      if (conversationMode && state === 'idle') startListening();
    }, 450);
  }

  /**
   * Stops the current answer and returns to idle, ready for the next
   * question. Shared by the manual "tap to interrupt" gesture and by
   * automatic barge-in detection (see startBargeInMonitor) — they differ
   * only in how soon the mic reopens afterward.
   */
  function interruptSpeaking({ listenImmediately = false } = {}) {
    stopSpeaking();
    stopTypewriter(true);
    setState('idle', conversationMode ? 'Hands-free — listening for your next question…' : 'Tap to speak');
    if (listenImmediately) {
      // The visitor was already mid-sentence when this fired — every extra
      // millisecond before the mic opens is a word of theirs not captured,
      // unlike the deliberate pause maybeAutoListen() adds after a tap.
      if (conversationMode && SpeechRecognition) startListening();
    } else {
      maybeAutoListen();
    }
  }

  /* ---------------- interactions ---------------- */

  el.mic.addEventListener('click', () => {
    // Both must happen inside this direct gesture handler, not an async
    // continuation after it — priming them here means audio actually plays
    // (and the orb has real levels to draw) by the time speak() runs.
    if (window.Orb) Orb.ensureContext();
    unlockAudio();

    if (state === 'listening') {
      // An explicit tap while the mic is already open is the visitor
      // choosing to stop, hands-free or not — honor it and disarm.
      conversationMode = false;
      stopListening();
      return;
    }
    if (state === 'speaking') {
      // Interrupting to talk over the answer reads as wanting to ask the
      // next thing right away, so hands-free mode (once armed) keeps going.
      interruptSpeaking();
      return;
    }
    if (state === 'thinking') return;

    if (!SpeechRecognition) {
      showFallbackForm();
      setStatus('This browser has no speech recognition. Type your question instead.', true);
      return;
    }
    conversationMode = true;
    noSpeechRetries = 0;
    startListening();
  });

  function setMuteIcon() {
    el.muteIconOn.hidden = muted;
    el.muteIconOff.hidden = !muted;
  }

  el.muteToggle.addEventListener('click', () => {
    muted = !muted;
    localStorage.setItem('voicekb:muted', muted ? '1' : '0');
    el.muteToggle.setAttribute('aria-pressed', String(muted));
    setMuteIcon();
    if (muted) stopSpeaking();
  });

  function showFallbackForm() {
    el.fallbackForm.hidden = false;
    el.keyboardToggle.hidden = true;
    el.fallbackInput.focus();
  }

  el.keyboardToggle.addEventListener('click', showFallbackForm);

  el.fallbackForm.addEventListener('submit', (event) => {
    event.preventDefault();
    if (window.Orb) Orb.ensureContext();
    unlockAudio();
    const value = el.fallbackInput.value.trim();
    if (!value) return;
    el.fallbackInput.value = '';
    submitTranscript(value);
  });

  el.resetBtn.addEventListener('click', () => {
    conversationMode = false;
    stopListening();
    stopMicVisualizer();
    stopSpeaking();
    stopTypewriter(false);
    hideDetail();
    el.exchange.hidden = true;
    el.emptyState.hidden = false;
    el.liveTranscript.textContent = '';
    setState('idle', 'Tap to speak — or press space');
  });

  document.addEventListener('keydown', (event) => {
    if (event.code !== 'Space' || event.target.tagName === 'INPUT') return;
    event.preventDefault();
    el.mic.click();
  });

  /* ---------------- boot ---------------- */

  async function boot() {
    el.muteToggle.setAttribute('aria-pressed', String(muted));
    setMuteIcon();

    if (!SpeechRecognition) {
      setStatus('Voice input needs Chrome, Edge, or Safari. Type instead.', true);
    }

    try {
      const response = await fetch('/api/bootstrap');
      const data = await response.json();

      voiceProvider = data.voice === 'server' ? 'server' : 'browser';

      document.title = `Ask ${data.name}`;
      el.brandName.textContent = `Ask ${data.name}`;
      el.answerLabel.textContent = data.name;
      el.greeting.textContent = data.greeting;
      el.subGreeting.textContent = data.subGreeting || el.subGreeting.textContent;
      el.badge.textContent = data.placeholder
        ? 'placeholder answers'
        : `${data.entries} answers`;
    } catch {
      el.badge.textContent = 'backend offline';
      setStatus('Backend is not reachable.', true);
    }

    setState('idle', 'Tap to speak — or press space');
  }

  boot();
})();

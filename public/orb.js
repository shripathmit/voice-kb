/**
 * Shared Web Audio plumbing — no longer draws anything. This module used to
 * also render a particle-sphere orb on a canvas; that visual was removed,
 * but the audio infrastructure it had already grown (autoplay unlock, the
 * playback graph server-voice audio is scheduled through, and the level
 * reading barge-in detection uses) is still load-bearing for app.js and
 * lives on here under its old name to avoid a churn-only rename.
 */
(function () {
  'use strict';

  let sharedCtx = null;
  let playbackJoin = null;
  let playbackAnalyser = null;
  let playbackData = null;

  /**
   * Created on the first direct user gesture (a click), never inside an
   * async continuation — some browsers refuse to start an AudioContext
   * otherwise. Safe to call repeatedly; it reuses the existing context.
   */
  function ensureContext() {
    if (!sharedCtx) {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      if (!Ctor) return null;
      try {
        sharedCtx = new Ctor();
      } catch {
        return null;
      }
    }
    if (sharedCtx.state === 'suspended') sharedCtx.resume().catch(() => {});
    return sharedCtx;
  }

  /**
   * The bulletproof autoplay unlock: a one-sample silent buffer played
   * directly through the Web Audio graph. Unlike `<audio>.play()` on a
   * fetched file, there is no network request and no container format for
   * the browser to reject — WebKit can only refuse this for the same reason
   * it would refuse any AudioContext use at all. Call synchronously inside a
   * real user gesture, same as ensureContext().
   */
  function playSilentBuffer() {
    try {
      const audioCtx = ensureContext();
      if (!audioCtx) return false;
      const buffer = audioCtx.createBuffer(1, 1, audioCtx.sampleRate);
      const source = audioCtx.createBufferSource();
      source.buffer = buffer;
      source.connect(audioCtx.destination);
      if (source.start) source.start(0);
      else if (source.noteOn) source.noteOn(0); // ancient WebKit fallback name
      return true;
    } catch {
      return false;
    }
  }

  /**
   * The join point for played-back answer audio: a standing GainNode wired
   * once to an analyser (for getPlaybackLevel()) and to the speakers.
   * Answer audio arrives as a stream of short-lived AudioBufferSourceNodes
   * (one per PCM frame from the server, scheduled back-to-back for gapless
   * playback — see app.js) rather than one persistent source, so every node
   * the caller creates for a frame should `.connect()` here instead of
   * there being one thing to wire up once.
   *
   * Returns null if the browser refused to create an AudioContext (in which
   * case the caller should fall back to browser speech instead).
   */
  function ensurePlaybackGraph() {
    const audioCtx = ensureContext();
    if (!audioCtx) return null;

    if (!playbackJoin) {
      playbackJoin = audioCtx.createGain();
      playbackAnalyser = audioCtx.createAnalyser();
      playbackAnalyser.fftSize = 256;
      playbackAnalyser.smoothingTimeConstant = 0.78;
      playbackJoin.connect(playbackAnalyser);
      // Still has to reach the speakers — tapping it for level-reading must
      // not silence the answer.
      playbackJoin.connect(audioCtx.destination);
      playbackData = new Uint8Array(playbackAnalyser.frequencyBinCount);
    }

    return playbackJoin;
  }

  /**
   * The current loudness of our own playing answer (0-1, or 0 when nothing
   * is wired up). This is the real, live level of what the speaker is
   * actually putting out — not an estimate — so it works as a reference
   * signal for telling "the visitor is talking over the answer" apart from
   * "the phone's own speaker is bleeding into its own mic," which a fixed
   * volume threshold cannot do: a browser's echoCancellation constraint is
   * built for WebRTC call audio and on many devices does nothing at all for
   * a plain <audio> element's output, so the raw mic level alone is not a
   * reliable signal for barge-in on its own.
   */
  function getPlaybackLevel() {
    if (!playbackAnalyser || !playbackData) return 0;
    playbackAnalyser.getByteFrequencyData(playbackData);
    let sum = 0;
    for (let i = 0; i < playbackData.length; i += 1) sum += playbackData[i];
    return Math.min(1, sum / playbackData.length / 70);
  }

  window.Orb = {
    ensureContext,
    playSilentBuffer,
    ensurePlaybackGraph,
    getPlaybackLevel,
  };
})();

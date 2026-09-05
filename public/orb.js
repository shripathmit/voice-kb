/**
 * The particle-sphere orb. Rendering technique is a direct port of the
 * reference mock: a uniformly-sampled point cloud inside a sphere, projected
 * with a slow rotation, breathing on a sine wave, and jittering with whatever
 * audio level is currently feeding it.
 *
 * What's new here is that the level source is swappable — the orb reacts to
 * the microphone while listening, to the actual TTS audio buffer while
 * speaking through the server voice, and to a synthetic pulse whenever there
 * is no real signal to read (browser speech synthesis exposes no audio data,
 * and muted mode has none at all). The orb never goes still because a voice
 * agent that stops moving while "speaking" reads as frozen, not calm.
 */
(function () {
  'use strict';

  const canvas = document.getElementById('orb');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');

  const DPR = Math.min(window.devicePixelRatio || 1, 2);
  const COUNT = 860;

  let particles = [];
  let audioLevel = 0;
  let levelSource = () => 0;
  let mode = 'idle'; // idle | listening | thinking | speaking

  function resize() {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    canvas.width = Math.floor(rect.width * DPR);
    canvas.height = Math.floor(rect.height * DPR);
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    buildParticles(rect.width, rect.height);
  }

  function buildParticles(w, h) {
    const radius = Math.min(w, h) * 0.33;
    particles = Array.from({ length: COUNT }, () => {
      // Uniform distribution inside a sphere, projected onto 2D.
      const u = Math.random();
      const v = Math.random();
      const theta = 2 * Math.PI * u;
      const phi = Math.acos(2 * v - 1);
      const rr = radius * Math.cbrt(Math.random());
      return {
        x: rr * Math.sin(phi) * Math.cos(theta),
        y: rr * Math.sin(phi) * Math.sin(theta),
        z: rr * Math.cos(phi),
        size: 0.45 + Math.random() * 1.15,
        phase: Math.random() * Math.PI * 2,
        speed: 0.35 + Math.random() * 0.8,
      };
    });
  }

  function animate(t) {
    const rect = canvas.getBoundingClientRect();
    const w = rect.width;
    const h = rect.height;
    const cx = w / 2;
    const cy = h / 2;
    ctx.clearRect(0, 0, w, h);

    const target = levelSource();
    audioLevel += (target - audioLevel) * 0.12;

    const breathe = 1 + Math.sin(t / 900) * 0.018 + audioLevel * 0.055;
    // A slightly faster spin while thinking reads as "working" without
    // needing any audio to pulse against.
    const rot = t * 0.00007 * (mode === 'thinking' ? 1.6 : 1);
    const cos = Math.cos(rot);
    const sin = Math.sin(rot);
    const jitterActive = mode === 'listening' || mode === 'speaking';

    const drawn = particles
      .map((p) => {
        const x = p.x * cos - p.z * sin;
        const z = p.x * sin + p.z * cos;
        let pulse = 0;
        if (jitterActive) pulse = Math.sin(t * 0.004 * p.speed + p.phase) * audioLevel * 5;
        else if (mode === 'thinking') pulse = Math.sin(t * 0.004 * p.speed + p.phase) * 0.6;
        return { p, x: x * breathe, y: (p.y + pulse) * breathe, z };
      })
      .sort((a, b) => a.z - b.z);

    const radius = Math.min(w, h) * 0.33 || 1;
    for (const d of drawn) {
      const depth = (d.z / radius + 1) / 2;
      const alpha = 0.16 + depth * 0.48 + audioLevel * 0.16;
      // ctx.arc() throws on a negative radius, and an uncaught throw here
      // would abort this function before its own requestAnimationFrame
      // call — silently killing the entire animation for the rest of the
      // page's life over one bad frame. depth (and so s) should always be
      // positive by construction, but clamping costs nothing and a frozen
      // orb is a worse failure mode than one frame drawn slightly wrong.
      const s = Math.max(0.1, d.p.size * (0.7 + depth * 0.75));
      ctx.beginPath();
      ctx.arc(cx + d.x, cy + d.y, s, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(203, 214, 255, ${Math.min(Math.max(alpha, 0), 1)})`;
      ctx.fill();
    }

    requestAnimationFrame(animate);
  }

  /* ---------------- level sources ---------------- */

  let sharedCtx = null;
  let micTeardown = null;
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

  function levelFromAnalyser(analyser, data) {
    return () => {
      analyser.getByteFrequencyData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i += 1) sum += data[i];
      return Math.min(1, sum / data.length / 70);
    };
  }

  /**
   * Wires the orb to the microphone. Returns a detach function; call it when
   * listening stops. Never throws — on failure the caller keeps whatever
   * level source was already active.
   */
  function attachMic(stream) {
    detachMic();
    try {
      const audioCtx = ensureContext();
      if (!audioCtx) return () => {};
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.82;
      const source = audioCtx.createMediaStreamSource(stream);
      source.connect(analyser);
      const data = new Uint8Array(analyser.frequencyBinCount);
      levelSource = levelFromAnalyser(analyser, data);
      micTeardown = () => {
        try {
          source.disconnect();
        } catch {}
      };
    } catch {
      micTeardown = null;
    }
    return detachMic;
  }

  function detachMic() {
    if (micTeardown) {
      micTeardown();
      micTeardown = null;
    }
  }

  /**
   * The join point for played-back answer audio: a standing GainNode wired
   * once to an analyser (for the orb's visual pulse and getPlaybackLevel())
   * and to the speakers. Answer audio arrives as a stream of short-lived
   * AudioBufferSourceNodes (one per PCM frame from the server, scheduled
   * back-to-back for gapless playback — see app.js) rather than one
   * <audio> element, so there is no single persistent source node to wire
   * up the way attachPlayback() on an <audio> element used to; every node
   * the caller creates for a frame should `.connect()` here instead.
   *
   * Returns null if the browser refused to create an AudioContext (in which
   * case the caller should fall back to a synthetic pulse instead).
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
      // Still has to reach the speakers — tapping it for visualisation must
      // not silence the answer.
      playbackJoin.connect(audioCtx.destination);
      playbackData = new Uint8Array(playbackAnalyser.frequencyBinCount);
    }

    levelSource = levelFromAnalyser(playbackAnalyser, playbackData);
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

  /**
   * There is nothing to tear down between answers — the graph is built once
   * and deliberately kept alive for reuse. Mode switches already stop
   * reading from it via useIdleLevel()/useThinkingLevel(); this exists so
   * app.js has one call it can always make without knowing which case it is.
   */
  function detachPlayback() {}

  /** A believable pulse for states with no real audio buffer to read. */
  function useSyntheticPulse(baseline, amplitude) {
    const start = performance.now();
    levelSource = () => baseline + Math.sin((performance.now() - start) / 230) * amplitude;
  }

  function useIdleLevel() {
    levelSource = () => 0;
  }

  function useThinkingLevel() {
    levelSource = () => 0.1;
  }

  function setMode(next) {
    mode = next;
    if (next === 'idle') {
      detachMic();
      detachPlayback();
      useIdleLevel();
    } else if (next === 'thinking') {
      detachMic();
      detachPlayback();
      useThinkingLevel();
    }
    // 'listening' and 'speaking' set their level source explicitly via
    // attachMic / ensurePlaybackGraph / useSyntheticPulse from app.js, since
    // only the caller knows which audio path is actually active.
  }

  window.Orb = {
    setMode,
    attachMic,
    detachMic,
    ensurePlaybackGraph,
    detachPlayback,
    useSyntheticPulse,
    ensureContext,
    playSilentBuffer,
    getPlaybackLevel,
  };

  // A plain window 'resize' listener isn't enough: the idle screen now
  // hides this canvas entirely (display: none) until a conversation
  // starts, so the very first resize() call — running at page load, while
  // idle — sees a 0×0 box and bails out without ever building particles or
  // sizing the canvas. No window resize event fires when CSS later makes
  // the element visible again on its own (a state change, not a viewport
  // change), so that bail was permanent — every particle kept whatever
  // stale x/y/z it never actually got, and the drawing loop's radius/depth
  // math on those went arbitrarily large or negative, throwing on
  // ctx.arc(). A ResizeObserver on the element itself fires for every
  // reason its box can change, display toggles included, so it re-runs
  // resize() exactly when the canvas actually needs it.
  new ResizeObserver(resize).observe(canvas);
  resize();
  requestAnimationFrame(animate);
})();

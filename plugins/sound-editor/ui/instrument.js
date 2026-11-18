// From a hum, a whistle or a beatbox to an instrument (docs/RESEARCH_LOG.md → "Instruments in the sound editor").
// Everything runs in the page, with no model: YIN pitch tracking finds the notes of one voice, onsets and brightness
// find a beatbox's kick / snare / hat; the notes are played by sampled General MIDI instruments (FluidR3, CC BY 3.0,
// ui/instruments/) and the drums are synthesized (808/909-style). Used by editor.js as window.KInstrument.
/* global window, OfflineAudioContext, TextDecoder, kesher */
(() => {
  "use strict";

  // ---------- pitch: YIN (de Cheveigné & Kawahara, 2002) on short frames ----------
  /**
   * The pitch of a frame, or 0 when it is not a clear note.
   *
   * @param x - The samples (one frame).
   * @param rate - Samples per second.
   * @returns Hz and how sure (0–1).
   */
  function yin(x, rate) {
    const half = x.length >> 1;
    const d = new Float32Array(half);
    for (let tau = 1; tau < half; tau++) {
      let s = 0;
      for (let i = 0; i < half; i++) { const v = x[i] - x[i + tau]; s += v * v; }
      d[tau] = s;
    }
    // Cumulative mean normalised difference; the first dip under the threshold is the period.
    let run = 0;
    d[0] = 1;
    for (let tau = 1; tau < half; tau++) { run += d[tau]; d[tau] = run ? (d[tau] * tau) / run : 1; }
    const minTau = Math.max(2, Math.floor(rate / 4000)), maxTau = Math.min(half - 1, Math.floor(rate / 60));
    for (let tau = minTau; tau < maxTau; tau++) {
      if (d[tau] < 0.15) {
        while (tau + 1 < maxTau && d[tau + 1] < d[tau]) tau++;
        // Parabolic interpolation for a finer period.
        const a = d[tau - 1], b = d[tau], c = d[tau + 1];
        const shift = (a - c) / (2 * (a - 2 * b + c) || 1);
        return { hz: rate / (tau + (Number.isFinite(shift) ? shift : 0)), sure: 1 - b };
      }
    }
    return { hz: 0, sure: 0 };
  }

  const midiOf = (hz) => 69 + 12 * Math.log2(hz / 440);

  /**
   * The notes of one voice (a hum, a whistle, a sung line) in a stretch of sound.
   *
   * @param x - Mono samples.
   * @param rate - Samples per second.
   * @returns Notes: start and end in seconds (from the stretch's start), a MIDI note, and a velocity 0–1.
   */
  function notes(x0, rate0) {
    // At about 11 kHz (a hum and a whistle are well under 4 kHz), so YIN stays fast: an average of each k samples.
    const k = Math.max(1, Math.floor(rate0 / 11025));
    const x = new Float32Array(Math.floor(x0.length / k));
    for (let i = 0; i < x.length; i++) { let s = 0; for (let j = 0; j < k; j++) s += x0[i * k + j]; x[i] = s / k; }
    const rate = rate0 / k;
    const size = 512, hop = 128;
    const frames = [];
    for (let i = 0; i + size < x.length; i += hop) {
      const f = x.subarray(i, i + size);
      let e = 0;
      for (let j = 0; j < size; j++) e += f[j] * f[j];
      const rms = Math.sqrt(e / size);
      const p = rms > 0.01 ? yin(f, rate) : { hz: 0, sure: 0 };
      frames.push({ t: i / rate, m: p.hz ? midiOf(p.hz) : 0, rms });
    }
    // A median of 5 frames smooths the jumps that are not notes.
    const med = frames.map((f, i) => {
      const w = frames.slice(Math.max(0, i - 2), i + 3).map((g) => g.m).filter(Boolean).sort((a, b) => a - b);
      return w.length >= 3 && f.m ? w[w.length >> 1] : 0;
    });
    const out = [];
    let cur = null;
    const end = (i) => {
      if (cur && frames[i - 1].t + size / rate - cur.start >= 0.08) {
        const ms = cur.ms.sort((a, b) => a - b);
        out.push({ start: cur.start, end: frames[i - 1].t + hop / rate, midi: Math.round(ms[ms.length >> 1]), vel: Math.min(1, 0.35 + cur.peak * 6) });
      }
      cur = null;
    };
    for (let i = 0; i < frames.length; i++) {
      const m = med[i];
      const dip = i > 1 && frames[i].rms > frames[i - 1].rms * 1.8 && frames[i - 1].rms < frames[i - 2].rms; // a new attack ("ta ta")
      if (!m) { end(i); continue; }
      if (cur && (Math.abs(m - cur.ref) > 0.7 || dip)) end(i);
      if (!cur) cur = { start: frames[i].t, ref: m, ms: [], peak: 0 };
      cur.ms.push(m);
      cur.ref = cur.ref * 0.8 + m * 0.2;
      cur.peak = Math.max(cur.peak, frames[i].rms);
    }
    end(frames.length);
    return out;
  }

  // ---------- key and beat ----------
  const MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
  const MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
  /** The key the notes are most likely in (Krumhansl–Schmuckler, weighted by length). */
  function keyOf(ns) {
    const h = new Array(12).fill(0);
    ns.forEach((n) => (h[((n.midi % 12) + 12) % 12] += n.end - n.start));
    let best = { root: 0, minor: false, r: -2 };
    for (let root = 0; root < 12; root++) {
      for (const [prof, minor] of [[MAJOR, false], [MINOR, true]]) {
        const p = prof.map((_, i) => prof[(i - root + 12) % 12]);
        const mh = h.reduce((a, b) => a + b, 0) / 12, mp = p.reduce((a, b) => a + b, 0) / 12;
        let num = 0, dh = 0, dp = 0;
        for (let i = 0; i < 12; i++) { num += (h[i] - mh) * (p[i] - mp); dh += (h[i] - mh) ** 2; dp += (p[i] - mp) ** 2; }
        const r = num / Math.sqrt(dh * dp || 1);
        if (r > best.r) best = { root, minor, r };
      }
    }
    return best;
  }
  const SCALE = { false: [0, 2, 4, 5, 7, 9, 11], true: [0, 2, 3, 5, 7, 8, 10] };
  /** Each note moved to the nearest note of the key. */
  const toKey = (ns, key) => ns.map((n) => {
    const pc = (((n.midi - key.root) % 12) + 12) % 12;
    const near = SCALE[key.minor].reduce((a, b) => (Math.abs(b - pc) < Math.abs(a - pc) ? b : a));
    return { ...n, midi: n.midi - pc + near };
  });
  /** Starts and ends on a grid of `step` seconds (an eighth at the tempo), each note at least one step. */
  const toBeat = (ns, step) => ns.map((n) => {
    const s = Math.round(n.start / step) * step;
    return { ...n, start: s, end: Math.max(s + step, Math.round(n.end / step) * step) };
  });

  // ---------- chords under the melody (Hookpad's and Band-in-a-Box's "harmonize", simply) ----------
  /**
   * A chord for each bar: the key's triad (I ii iii IV V vi, or the minor key's i iv v VI III VII) whose notes the
   * melody sings most in that bar, the main chords (I, IV, V) a little preferred, and the first and last bar on the home
   * chord when it fits. Played low and soft, as block chords for the whole bar.
   *
   * @param ns - The melody (in the key, ideally).
   * @param key - From keyOf.
   * @param bar - A bar's length in seconds (four beats).
   * @param length - How long the stretch is, in seconds.
   * @returns The chord notes ({ midi, start, end, vel }).
   */
  function chords(ns, key, bar, length) {
    const sc = SCALE[key.minor];
    // Triads on the degrees, as pitch classes from the root; diminished ones (vii°, ii° in minor) are left out.
    const degrees = key.minor ? [0, 3, 4, 5, 2, 6] : [0, 1, 2, 3, 4, 5];
    const triad = (d) => [sc[d], sc[(d + 2) % 7] + (d + 2 >= 7 ? 12 : 0), sc[(d + 4) % 7] + (d + 4 >= 7 ? 12 : 0)];
    const main = new Set(key.minor ? [0, 3, 4] : [0, 3, 4]);
    const out = [];
    const bars = Math.max(1, Math.ceil(length / bar));
    for (let b = 0; b < bars; b++) {
      const t0 = b * bar, t1 = Math.min(length, t0 + bar);
      const w = new Array(12).fill(0);
      ns.forEach((n) => { const o = Math.min(n.end, t1) - Math.max(n.start, t0); if (o > 0) w[(((n.midi - key.root) % 12) + 12) % 12] += o; });
      let best = degrees[0], score = -1;
      for (const d of degrees) {
        const pcs = triad(d).map((x) => x % 12);
        let sum = pcs.reduce((a, pc) => a + w[pc], 0) * (main.has(d) ? 1.15 : 1);
        if ((b === 0 || b === bars - 1) && d === 0) sum *= 1.3;
        if (sum > score) { score = sum; best = d; }
      }
      if (score <= 0 && b > 0) { const prev = out.length ? out.slice(-3) : []; prev.forEach((n) => out.push({ ...n, start: t0, end: t1 })); continue; }
      // The triad from C3 up, its root doubled an octave below as the bass.
      const root = 48 + ((key.root + sc[best]) % 12);
      triad(best).forEach((x, i) => out.push({ midi: root + (x - sc[best]) + (i === 0 ? -12 : 0), start: t0, end: Math.max(t0 + 0.2, t1 - 0.05), vel: i === 0 ? 0.5 : 0.38 }));
    }
    return out;
  }

  // ---------- a beatbox: hits and what they are ----------
  /**
   * The hits of a beatbox: where the energy jumps, and whether it is low (kick), noisy and bright (hat) or between
   * (snare), by the share of fast changes in the sound (zero crossings).
   */
  function hits(x, rate) {
    const size = 1024, hop = 256;
    const out = [];
    let prev = 0, last = -1;
    for (let i = 0; i + size < x.length; i += hop) {
      let e = 0, z = 0;
      for (let j = 0; j < size; j++) { const v = x[i + j]; e += v * v; if (j && (v >= 0) !== (x[i + j - 1] >= 0)) z++; }
      e = Math.sqrt(e / size);
      const t = i / rate;
      if (e > 0.03 && e > prev * 2.2 && t - last > 0.07) {
        const zcr = (z / size) * rate; // crossings per second ≈ how bright
        out.push({ start: t, kind: zcr < 900 ? "kick" : zcr > 4000 ? "hat" : "snare", vel: Math.min(1, 0.4 + e * 5) });
        last = t;
      }
      prev = e;
    }
    return out;
  }

  // ---------- instruments ----------
  const INSTRUMENTS = [
    ["acoustic_grand_piano", "🎹", "פסנתר", "Piano"], ["acoustic_guitar_steel", "🎸", "גיטרה אקוסטית", "Acoustic guitar"], ["electric_guitar_clean", "⚡", "גיטרה חשמלית", "Electric guitar"],
    ["electric_bass_finger", "🎸", "בס", "Bass"], ["violin", "🎻", "כינור", "Violin"], ["cello", "🎻", "צ'לו", "Cello"], ["string_ensemble_1", "🎼", "כלי קשת", "Strings"],
    ["trumpet", "🎺", "חצוצרה", "Trumpet"], ["alto_sax", "🎷", "סקסופון", "Saxophone"], ["flute", "🪈", "חליל", "Flute"], ["clarinet", "🎵", "קלרינט", "Clarinet"],
    ["choir_aahs", "👥", "מקהלה", "Choir"], ["lead_2_sawtooth", "🎛", "סינת'", "Synth"], ["drums", "🥁", "תופים (מביטבוקס)", "Drums (from a beatbox)"],
  ];
  const NAMES = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"];
  const noteName = (m) => `${NAMES[m % 12]}${Math.floor(m / 12) - 1}`;
  let index = null;
  const loaded = new Map(); // "inst/C4" → AudioBuffer
  async function samples(ctx, inst, needed) {
    index ??= JSON.parse(new TextDecoder().decode(await kesher.call("own.file", { path: "ui/instruments/index.json" })));
    const have = index[inst] ?? [];
    const pick = (m) => have.reduce((a, b) => (Math.abs(b - m) < Math.abs(a - m) ? b : a), have[0]);
    const want = [...new Set(needed.map(pick))];
    await Promise.all(want.map(async (s) => {
      const key = `${inst}/${noteName(s)}`;
      if (!loaded.has(key)) loaded.set(key, await ctx.decodeAudioData(await kesher.call("own.file", { path: `ui/instruments/${key}.mp3` })));
    }));
    return (m) => { const s = pick(m); return { buf: loaded.get(`${inst}/${noteName(s)}`), shift: m - s }; };
  }
  /** Notes played by an instrument, as mono samples `length` long. Octaves are moved into the instrument's range. */
  async function render(ns, inst, rate, length) {
    const ctx = new OfflineAudioContext(1, Math.max(1, length), rate);
    const range = index?.[inst] ?? [];
    const fit = (m) => { if (!range.length) return m; let n = m; while (n < range[0] - 1) n += 12; while (n > range[range.length - 1] + 2) n -= 12; return n; };
    const play = await samples(ctx, inst, ns.map((n) => fit(n.midi)));
    for (const n of ns) {
      const { buf, shift } = play(fit(n.midi));
      if (!buf) continue;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.playbackRate.value = Math.pow(2, shift / 12);
      const g = ctx.createGain();
      const dur = Math.max(0.08, n.end - n.start), rel = 0.18;
      g.gain.setValueAtTime(0, n.start);
      g.gain.linearRampToValueAtTime(0.9 * n.vel, n.start + 0.008);
      g.gain.setValueAtTime(0.9 * n.vel, n.start + dur);
      g.gain.linearRampToValueAtTime(0, n.start + dur + rel);
      src.connect(g).connect(ctx.destination);
      src.start(n.start);
      src.stop(n.start + dur + rel + 0.02);
    }
    return (await ctx.startRendering()).getChannelData(0);
  }
  /** Synthesized drums at the hits (no samples): a falling sine kick, a noise-and-tone snare, a short bright hat. */
  async function renderDrums(hs, rate, length) {
    const ctx = new OfflineAudioContext(1, Math.max(1, length), rate);
    const noise = ctx.createBuffer(1, rate, rate);
    const nd = noise.getChannelData(0);
    for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
    for (const h of hs) {
      const t = h.start, v = h.vel;
      if (h.kind === "kick") {
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.frequency.setValueAtTime(150, t); o.frequency.exponentialRampToValueAtTime(45, t + 0.12);
        g.gain.setValueAtTime(v, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.45);
        o.connect(g).connect(ctx.destination); o.start(t); o.stop(t + 0.5);
      } else {
        const n = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
        n.buffer = noise;
        f.type = h.kind === "hat" ? "highpass" : "bandpass";
        f.frequency.value = h.kind === "hat" ? 7000 : 1800;
        const len = h.kind === "hat" ? 0.06 : 0.2;
        g.gain.setValueAtTime(v * (h.kind === "hat" ? 0.35 : 0.7), t); g.gain.exponentialRampToValueAtTime(0.001, t + len);
        n.connect(f).connect(g).connect(ctx.destination); n.start(t); n.stop(t + len + 0.02);
        if (h.kind === "snare") {
          const o = ctx.createOscillator(), og = ctx.createGain();
          o.frequency.value = 185; og.gain.setValueAtTime(v * 0.5, t); og.gain.exponentialRampToValueAtTime(0.001, t + 0.1);
          o.connect(og).connect(ctx.destination); o.start(t); o.stop(t + 0.12);
        }
      }
    }
    return (await ctx.startRendering()).getChannelData(0);
  }

  window.KInstrument = { notes, keyOf, toKey, toBeat, hits, render, renderDrums, chords, INSTRUMENTS, noteName };
})();

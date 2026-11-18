// Noise clean-up for the sound editor, as Audacity's Noise Reduction (spectral gating): learn what the noise sounds
// like, frequency by frequency, then turn down each moment and frequency that is no louder than it. The gain is smoothed
// over time and frequency, so the leftover noise does not "twinkle" (the musical noise of a hard gate).
//
// window.KClean.profile(samples, rate, from?, to?) learns the noise (from a stretch, or from the quietest moments);
// window.KClean.clean(samples, profile, { reduce, sensitivity }) returns the cleaned samples.
/* global window */
(function () {
  "use strict";
  const N = 2048, HOP = N / 4;
  const win = new Float32Array(N).map((_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));
  const rev = new Uint32Array(N).map((_, i) => { let r = 0; for (let b = 1, x = i; b < N; b <<= 1, x >>= 1) r = (r << 1) | (x & 1); return r; });

  /** An in-place radix-2 FFT (inverse when inv), on separate real and imaginary arrays of length N. */
  function fft(re, im, inv) {
    for (let i = 0; i < N; i++) { const j = rev[i]; if (j > i) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; } }
    for (let size = 2; size <= N; size <<= 1) {
      const half = size >> 1, step = ((inv ? 2 : -2) * Math.PI) / size;
      for (let i = 0; i < N; i += size) for (let k = 0; k < half; k++) {
        const c = Math.cos(step * k), s = Math.sin(step * k), a = i + k, b = a + half;
        const tr = re[b] * c - im[b] * s, ti = re[b] * s + im[b] * c;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
      }
    }
    if (inv) for (let i = 0; i < N; i++) { re[i] /= N; im[i] /= N; }
  }

  /** Each frame's magnitudes (N/2 + 1 bins), hop by hop. */
  function frames(x, from, to, each) {
    const re = new Float32Array(N), im = new Float32Array(N);
    for (let start = from - N + HOP; start < to; start += HOP) {
      for (let i = 0; i < N; i++) { const k = start + i; re[i] = k >= 0 && k < x.length ? x[k] * win[i] : 0; im[i] = 0; }
      fft(re, im, false);
      each(start, re, im);
    }
  }

  /**
   * Learns the noise: each frequency's mean level.
   *
   * @param x - The samples (one channel, or a mix).
   * @param from - The start of a stretch that is only noise; without it, the quietest tenth of the sound is used.
   * @param to - Its end.
   * @returns The noise's level per frequency bin.
   */
  function profile(x, from, to) {
    const bins = N / 2 + 1;
    const all = [];
    frames(x, from ?? 0, to ?? x.length, (_s, re, im) => {
      const m = new Float32Array(bins);
      let e = 0;
      for (let k = 0; k < bins; k++) { m[k] = Math.hypot(re[k], im[k]); e += m[k]; }
      all.push({ m, e });
    });
    // No stretch chosen: the quietest tenth of the frames (pauses between words) is taken as the noise.
    const use = from == null ? all.slice().sort((a, b) => a.e - b.e).slice(0, Math.max(4, Math.ceil(all.length / 10))) : all;
    const p = new Float32Array(bins);
    use.forEach(({ m }) => { for (let k = 0; k < bins; k++) p[k] += m[k] / use.length; });
    return p;
  }

  /**
   * Turns the noise down.
   *
   * @param x - The samples of one channel.
   * @param p - The noise (from profile).
   * @param opts - reduce: how much quieter the noise gets, in dB (12); sensitivity: how far above the noise a sound must be
   *   to stay (2 = twice the noise's level).
   * @returns The cleaned samples (as long as x).
   */
  function clean(x, p, opts = {}) {
    const floor = Math.pow(10, -(opts.reduce ?? 12) / 20), sens = opts.sensitivity ?? 2;
    const bins = N / 2 + 1;
    const out = new Float32Array(x.length);
    const norm = new Float32Array(x.length);
    let prev = new Float32Array(bins).fill(1);
    frames(x, 0, x.length, (start, re, im) => {
      // The gain for each frequency: full where the sound is above the noise, the floor where it is not; then smoothed
      // across neighbouring frequencies, and released slowly from the frame before (so word endings are not cut).
      const raw = new Float32Array(bins);
      for (let k = 0; k < bins; k++) raw[k] = Math.hypot(re[k], im[k]) > p[k] * sens ? 1 : floor;
      const g = new Float32Array(bins);
      for (let k = 0; k < bins; k++) {
        let s = 0, n = 0;
        for (let j = Math.max(0, k - 2); j <= Math.min(bins - 1, k + 2); j++) { s += raw[j]; n++; }
        g[k] = Math.max(s / n, prev[k] * 0.7, floor);
      }
      prev = g;
      for (let k = 0; k < bins; k++) { re[k] *= g[k]; im[k] *= g[k]; if (k > 0 && k < N / 2) { re[N - k] *= g[k]; im[N - k] *= g[k]; } }
      fft(re, im, true);
      for (let i = 0; i < N; i++) { const at = start + i; if (at >= 0 && at < x.length) { out[at] += re[i] * win[i]; norm[at] += win[i] * win[i]; } }
    });
    for (let i = 0; i < x.length; i++) out[i] = norm[i] > 1e-6 ? out[i] / norm[i] : 0;
    return out;
  }

  window.KClean = { profile, clean };
})();

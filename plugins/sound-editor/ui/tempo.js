// A sound faster or slower with its pitch kept (Audacity's Change Tempo, CapCut's speed with "keep pitch"), by WSOLA
// (waveform-similarity overlap-add; Verhelst & Roelands, 1993): the sound is cut into overlapping windows taken k times
// as far apart as they are laid down, and each window is nudged (up to a few ms) to where it best continues the last
// one, so the waves line up and no echo or warble is heard. No library: plain arrays, one pass.

const FRAME = 0.046; // seconds per window (~2048 samples at 44.1 kHz): long enough for low voices
const SEEK = 0.012; // how far a window may move to line up (seconds)

/**
 * Stretches the channels together (the same windows for all, so stereo stays in place).
 *
 * @param chans - Float32Array per channel, all the same length.
 * @param k - The speed: 2 is twice as fast (half as long), 0.5 half as fast. 0.25 to 4.
 * @param rate - Samples per second.
 * @returns The new channels, about `length / k` long.
 */
export function stretch(chans, k, rate) {
  const len = chans[0]?.length ?? 0;
  const N = Math.max(256, 2 * Math.round((FRAME * rate) / 2));
  const hop = N / 2, seek = Math.round(SEEK * rate);
  const outLen = Math.max(1, Math.round(len / k));
  if (len < N * 2) return chans.map((c) => resample(c, outLen));
  // The windows' search runs on a mix of the channels; a short stretch of it (and every 2nd sample) is compared,
  // enough to line the waves up and fast in a page.
  const mono = new Float32Array(len);
  for (const c of chans) for (let i = 0; i < len; i++) mono[i] += c[i] / chans.length;
  const win = new Float32Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
  const out = chans.map(() => new Float32Array(outLen + N));
  const weight = new Float32Array(outLen + N);
  const cmp = Math.min(hop, Math.round(0.01 * rate));
  let prev = 0; // where the last window was taken from
  for (let m = 0; m * hop < outLen; m++) {
    const at = Math.round(m * hop * k);
    let from = Math.min(at, len - N);
    if (m > 0) {
      // Where the last window would go on naturally; the window here is moved to look most like it.
      const natural = prev + hop;
      let best = -Infinity;
      const lo = Math.max(0, at - seek), hi = Math.min(len - N, at + seek);
      for (let d = lo; d <= hi; d++) {
        let s = 0;
        for (let i = 0; i < cmp; i += 2) s += mono[d + i] * (mono[natural + i] ?? 0);
        if (s > best) { best = s; from = d; }
      }
    }
    if (from < 0) break;
    const to = m * hop;
    chans.forEach((c, ch) => { const o = out[ch]; for (let i = 0; i < N; i++) o[to + i] += c[from + i] * win[i]; });
    for (let i = 0; i < N; i++) weight[to + i] += win[i];
    prev = from;
  }
  return out.map((o) => {
    const r = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) r[i] = weight[i] > 1e-3 ? o[i] / weight[i] : o[i];
    return r;
  });
}

/** A short sound (under two windows) is simply read faster or slower. */
function resample(c, n) {
  const r = new Float32Array(n), k = c.length / n;
  for (let i = 0; i < n; i++) { const x = i * k, j = Math.floor(x), f = x - j; r[i] = (c[j] ?? 0) * (1 - f) + (c[Math.min(j + 1, c.length - 1)] ?? 0) * f; }
  return r;
}

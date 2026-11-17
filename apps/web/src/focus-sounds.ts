/**
 * Focus sounds (design FocusComfort; RESEARCH_LOG students part 26 #5): brown noise, rain and waves made in the
 * browser with Web Audio, nothing downloaded. One sound at a time, kept playing across pages.
 */
export type FocusSound = "off" | "brown" | "rain" | "waves";

let ctx: AudioContext | null = null;
let nodes: AudioNode[] = [];
let gain: GainNode | null = null;
let current: FocusSound = "off";
let volume = 0.4;

/** A few seconds of noise, looped: white, or brown (each sample a small step from the last). */
function noise(c: AudioContext, kind: "white" | "brown"): AudioBufferSourceNode {
  const len = c.sampleRate * 4;
  const buf = c.createBuffer(1, len, c.sampleRate);
  const d = buf.getChannelData(0);
  let last = 0;
  for (let i = 0; i < len; i++) {
    const w = Math.random() * 2 - 1;
    if (kind === "white") d[i] = w * 0.5;
    else {
      last = (last + 0.02 * w) / 1.02;
      d[i] = last * 3.5;
    }
  }
  const src = c.createBufferSource();
  src.buffer = buf;
  src.loop = true;
  return src;
}

/** Stops the sound. */
export function stopFocusSound(): void {
  for (const n of nodes) {
    try {
      (n as AudioScheduledSourceNode).stop?.();
    } catch {
      // already stopped
    }
    n.disconnect();
  }
  nodes = [];
  current = "off";
}

/** Plays a sound (or stops with "off"). */
export function playFocusSound(kind: FocusSound): void {
  stopFocusSound();
  if (kind === "off" || typeof AudioContext === "undefined") return;
  ctx ??= new AudioContext();
  void ctx.resume();
  gain = ctx.createGain();
  gain.gain.value = volume;
  gain.connect(ctx.destination);
  if (kind === "brown") {
    const src = noise(ctx, "brown");
    src.connect(gain);
    src.start();
    nodes = [src, gain];
  } else if (kind === "rain") {
    // Rain: white noise through a band around 1–4 kHz, softened.
    const src = noise(ctx, "white");
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 900;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 5000;
    src.connect(hp).connect(lp).connect(gain);
    src.start();
    nodes = [src, hp, lp, gain];
  } else {
    // Waves: brown noise whose loudness rises and falls every ~8 seconds.
    const src = noise(ctx, "brown");
    const swell = ctx.createGain();
    swell.gain.value = 0.55;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.12;
    const depth = ctx.createGain();
    depth.gain.value = 0.45;
    lfo.connect(depth).connect(swell.gain);
    src.connect(swell).connect(gain);
    src.start();
    lfo.start();
    nodes = [src, lfo, depth, swell, gain];
  }
  current = kind;
}

/** Changes the volume (0–1). */
export function setFocusVolume(v: number): void {
  volume = Math.max(0, Math.min(1, v));
  if (gain) gain.gain.value = volume;
}

/** What is playing, and how loud. */
export function focusSoundState(): { sound: FocusSound; volume: number } {
  return { sound: current, volume };
}

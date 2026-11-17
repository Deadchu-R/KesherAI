/**
 * Feedback that feels good (RESEARCH_LOG students part 25 #5, like Duolingo's): a soft chime on a right answer, and a
 * small burst of confetti for a finished goal, session or new best. The chime can be muted (Settings → Study → View,
 * kept on this device); the confetti never shows with reduced motion.
 */
const MUTE_KEY = "kesher-study-quiet";

/** Whether study sounds are off on this device. */
export function studySoundsMuted(): boolean {
  try {
    return localStorage.getItem(MUTE_KEY) === "1";
  } catch {
    return false;
  }
}

/** Turns study sounds off or on (this device). */
export function muteStudySounds(off: boolean): void {
  try {
    if (off) localStorage.setItem(MUTE_KEY, "1");
    else localStorage.removeItem(MUTE_KEY);
  } catch {
    // private mode
  }
}

let ctx: AudioContext | null = null;

/** A soft chime: two notes up for "right", three for "done". */
export function chime(kind: "right" | "done" = "right"): void {
  if (studySoundsMuted() || typeof AudioContext === "undefined") return;
  try {
    ctx ??= new AudioContext();
    void ctx.resume();
    const notes = kind === "right" ? [660, 880] : [523, 659, 784, 1047];
    notes.forEach((f, i) => {
      const o = ctx!.createOscillator();
      const g = ctx!.createGain();
      o.type = "sine";
      o.frequency.value = f;
      const t = ctx!.currentTime + i * 0.09;
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.12, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
      o.connect(g).connect(ctx!.destination);
      o.start(t);
      o.stop(t + 0.4);
    });
  } catch {
    // no audio
  }
}

/** A short burst of confetti over the page, and the "done" chime. */
export function celebrate(): void {
  chime("done");
  if (typeof document === "undefined" || matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
  const box = document.createElement("div");
  box.className = "confetti";
  box.setAttribute("aria-hidden", "true");
  const colors = ["#a5b4ff", "#7fd8a8", "#f0a830", "#ff7a7a", "#c792ea"];
  for (let i = 0; i < 36; i++) {
    const p = document.createElement("i");
    p.style.left = `${Math.random() * 100}%`;
    p.style.background = colors[i % colors.length]!;
    p.style.animationDelay = `${Math.random() * 0.3}s`;
    p.style.setProperty("--x", `${(Math.random() - 0.5) * 160}px`);
    p.style.setProperty("--r", `${Math.random() * 720 - 360}deg`);
    box.appendChild(p);
  }
  document.body.appendChild(box);
  setTimeout(() => box.remove(), 2200);
}

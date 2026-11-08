import { useEffect, useState } from "react";
import { withToken } from "./api";
import { getLocale, t } from "./i18n";

const VOICE_KEY = "kesher-tts-voice"; // "system:<voiceURI>" | "cloud:openai:<voice>" | ""
const AUTO_KEY = "kesher-tts-auto";

const read = (k: string) => {
  try {
    return localStorage.getItem(k) ?? "";
  } catch {
    return "";
  }
};
const write = (k: string, v: string) => {
  try {
    localStorage.setItem(k, v);
  } catch {
    // not remembered; fine
  }
};

/** Text without code blocks, links and markdown, as it should be heard. */
export function speakable(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, getLocale() === "he" ? " (קוד) " : " (code) ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[#*_>|~]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 6000);
}

let current: { stop: () => void } | null = null;
/** Changes every time reading starts or stops, so a voice that was still loading does not start after Stop. */
let gen = 0;
let loading: AbortController | null = null;
const speakingListeners = new Set<(on: boolean) => void>();
let speakingNow = false;
const setSpeaking = (on: boolean) => {
  speakingNow = on;
  for (const l of speakingListeners) l(on);
};

/** @returns Whether something is being read aloud (or getting ready to be). */
export function useSpeaking(): boolean {
  const [on, setOn] = useState(speakingNow);
  useEffect(() => {
    speakingListeners.add(setOn);
    return () => void speakingListeners.delete(setOn);
  }, []);
  return on;
}

/** The Android app's own voice (the page's speechSynthesis has no voices inside the app). */
type NativeVoice = {
  speak(o: { text: string; language?: string }): Promise<{ id?: string }>;
  stopSpeaking(): Promise<void>;
  addListener(event: "spoken", cb: (e: { id?: string }) => void): Promise<{ remove: () => void }> | { remove: () => void };
};
const nativeVoice = (): NativeVoice | undefined => (window as unknown as { Capacitor?: { Plugins?: { KesherSpeech?: NativeVoice } } }).Capacitor?.Plugins?.KesherSpeech;

/** Stops whatever is being read aloud. */
export function stopSpeaking(): void {
  gen++;
  loading?.abort();
  loading = null;
  const c = current;
  current = null;
  c?.stop();
  if (typeof speechSynthesis !== "undefined") speechSynthesis.cancel();
  void nativeVoice()?.stopSpeaking().catch(() => undefined);
  setSpeaking(false);
}

/**
 * Reads text aloud: with a cloud voice (OpenAI, through the server) when
 * chosen, otherwise with the computer's own voices (no download; Windows and
 * macOS include Hebrew voices).
 *
 * @param text - What to say.
 * @param onEnd - Called when it finishes or stops.
 */
export async function speak(text: string, done?: () => void): Promise<void> {
  stopSpeaking();
  const say = speakable(text);
  if (!say) return done?.();
  const my = ++gen;
  const stale = () => my !== gen;
  loading = new AbortController();
  const signal = loading.signal;
  let ended = false;
  const onEnd = () => {
    if (ended) return;
    ended = true;
    if (!stale()) setSpeaking(false);
    done?.();
  };
  setSpeaking(true);
  // Stop pressed while the voice was still loading: end here.
  const playAudio = async (res: Response) => {
    const blob = await res.blob();
    if (stale()) return onEnd();
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    current = { stop: () => { audio.pause(); URL.revokeObjectURL(url); onEnd(); } };
    audio.onended = () => { URL.revokeObjectURL(url); current = null; onEnd(); };
    await audio.play().catch(() => onEnd());
  };
  const voice = read(VOICE_KEY);
  // The natural voice on this computer (Kokoro) speaks English; Hebrew goes to the system's voice.
  if (voice.startsWith("local:") && !/[֐-׿]/.test(say)) {
    const res = await fetch(withToken("/api/speech/tts"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: say, provider: "local", voice: voice.slice(6) }), signal }).catch(() => undefined);
    if (stale()) return onEnd();
    if (res?.ok) return playAudio(res);
  }
  if (voice.startsWith("cloud:")) {
    const [, provider, name] = voice.split(":");
    const res = await fetch(withToken("/api/speech/tts"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: say, provider, voice: name }), signal }).catch(() => undefined);
    if (stale()) return onEnd();
    if (res?.ok) return playAudio(res);
    // Fall back to the computer's voice if the cloud fails.
  }
  const nv = nativeVoice();
  if (nv) {
    let done = false;
    const said: { id?: string } = {};
    const finish = () => {
      if (done) return;
      done = true;
      current = null;
      void Promise.resolve(sub).then((x) => x.remove());
      onEnd();
    };
    const sub = nv.addListener("spoken", (e) => {
      if (!said.id || !e.id || e.id === said.id) finish();
    });
    current = { stop: () => { void nv.stopSpeaking(); finish(); } };
    said.id = (await nv.speak({ text: say, language: /[֐-׿]/.test(say) ? "he-IL" : "en-US" }).catch(() => ({ id: undefined }))).id;
    return;
  }
  if (typeof speechSynthesis === "undefined" || typeof SpeechSynthesisUtterance === "undefined") return onEnd();
  const u = new SpeechSynthesisUtterance(say);
  const voices = speechSynthesis.getVoices();
  const chosen = voice.startsWith("system:") ? voices.find((v) => v.voiceURI === voice.slice(7)) : undefined;
  const hebrew = /[֐-׿]/.test(say);
  u.voice = chosen ?? voices.find((v) => (hebrew ? /^he|^iw/i.test(v.lang) : v.lang.startsWith(getLocale() === "he" ? "en" : "en"))) ?? null;
  u.lang = u.voice?.lang ?? (hebrew ? "he-IL" : "en-US");
  u.onend = () => { current = null; onEnd(); };
  u.onerror = () => { current = null; onEnd(); };
  current = { stop: () => { speechSynthesis.cancel(); onEnd(); } };
  speechSynthesis.speak(u);
}

/**
 * A Stop button that shows while anything is read aloud (an answer, the
 * automatic reading, voice mode), on every page. Esc stops it too.
 */
export function StopSpeakingBar() {
  const on = useSpeaking();
  useEffect(() => {
    if (!on) return;
    const key = (e: KeyboardEvent) => e.key === "Escape" && stopSpeaking();
    addEventListener("keydown", key);
    return () => removeEventListener("keydown", key);
  }, [on]);
  if (!on) return null;
  return (
    <button type="button" className="stop-speaking" onClick={stopSpeaking} aria-label={t("ttsStop")}>
      <span aria-hidden="true">■</span> {t("ttsStop")}
    </button>
  );
}

/** Whether answers are read aloud as they arrive. */
export const autoSpeak = (): boolean => read(AUTO_KEY) === "1";

/**
 * 🔊 under an answer: read it aloud, or stop.
 *
 * @param props.text - The answer.
 */
export function SpeakButton({ text }: { text: string }) {
  const [on, setOn] = useState(false);
  return (
    <button
      type="button"
      className={`say-btn${on ? " on" : ""}`}
      aria-pressed={on}
      title={on ? t("ttsStop") : t("ttsRead")}
      aria-label={on ? t("ttsStop") : t("ttsRead")}
      onClick={() => {
        if (on) {
          stopSpeaking();
          setOn(false);
        } else {
          setOn(true);
          void speak(text, () => setOn(false));
        }
      }}
    >
      {on ? "■" : "🔊"}
    </button>
  );
}

/** Settings → Speech, reading aloud: the voice, and reading answers automatically. */
export function VoicePicker({ clouds }: { clouds: string[] }) {
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [voice, setVoice] = useState(read(VOICE_KEY));
  const [auto, setAuto] = useState(autoSpeak());
  useEffect(() => {
    // Inside the Android app the page has no speechSynthesis (the phone's own voice is used instead).
    if (typeof speechSynthesis === "undefined") return;
    const load = () => setVoices(speechSynthesis.getVoices());
    load();
    speechSynthesis.addEventListener("voiceschanged", load);
    return () => speechSynthesis.removeEventListener("voiceschanged", load);
  }, []);
  const [local, setLocal] = useState<{ ready: boolean; busy: boolean; sizeMb: number; voices: Array<{ id: number; name: string }> } | null>(null);
  const loadLocal = () => void fetch(withToken("/api/speech/tts/local")).then((r) => (r.ok ? r.json() : null)).then(setLocal, () => undefined);
  useEffect(loadLocal, []);
  useEffect(() => {
    if (!local?.busy) return;
    const id = setInterval(loadLocal, 3000);
    return () => clearInterval(id);
  }, [local?.busy]);
  const sorted = [...voices].sort((a, b) => Number(/^he|^iw/i.test(b.lang)) - Number(/^he|^iw/i.test(a.lang)) || a.lang.localeCompare(b.lang));
  return (
    <>
      <label className="stack">
        <span>{t("ttsVoice")}</span>
        <select value={voice} onChange={(e) => { setVoice(e.target.value); write(VOICE_KEY, e.target.value); }}>
          <option value="">{t("ttsVoiceAuto")}</option>
          {local?.ready && local.voices.map((v) => <option key={v.id} value={`local:${v.id}`}>{t("ttsLocal")} · {v.name}</option>)}
          {clouds.includes("openai") && ["alloy", "nova", "shimmer", "echo", "onyx", "sage"].map((v) => <option key={v} value={`cloud:openai:${v}`}>OpenAI · {v}</option>)}
          {sorted.map((v) => <option key={v.voiceURI} value={`system:${v.voiceURI}`}>{v.name} ({v.lang})</option>)}
        </select>
      </label>
      {voices.length > 0 && !voices.some((v) => /^he|^iw/i.test(v.lang)) && <p className="muted small">{t("ttsNoHebrew")}</p>}
      {local && !local.ready && (
        <p className="row small">
          <span className="grow muted">{local.busy ? t("ttsLocalPreparing") : t("ttsLocalOffer", { mb: local.sizeMb })}</span>
          {!local.busy && <button type="button" onClick={() => void fetch(withToken("/api/speech/tts/local/setup"), { method: "POST" }).then(() => setLocal({ ...local, busy: true }))}>{t("micDownload")}</button>}
        </p>
      )}
      <label className="row tts-auto">
        <input type="checkbox" checked={auto} onChange={(e) => { setAuto(e.target.checked); write(AUTO_KEY, e.target.checked ? "1" : "0"); }} />
        <span>{t("ttsAuto")}</span>
      </label>
      <button type="button" onClick={() => void speak(getLocale() === "he" ? "שלום, ככה אני נשמע." : "Hello, this is how I sound.")}>{t("ttsTry")}</button>
    </>
  );
}

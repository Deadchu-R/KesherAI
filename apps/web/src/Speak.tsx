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

/** Stops whatever is being read aloud. */
export function stopSpeaking(): void {
  current?.stop();
  current = null;
}

/**
 * Reads text aloud: with a cloud voice (OpenAI, through the server) when
 * chosen, otherwise with the computer's own voices (no download; Windows and
 * macOS include Hebrew voices).
 *
 * @param text - What to say.
 * @param onEnd - Called when it finishes or stops.
 */
export async function speak(text: string, onEnd?: () => void): Promise<void> {
  stopSpeaking();
  const say = speakable(text);
  if (!say) return onEnd?.();
  const voice = read(VOICE_KEY);
  if (voice.startsWith("cloud:")) {
    const [, provider, name] = voice.split(":");
    const res = await fetch(withToken("/api/speech/tts"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: say, provider, voice: name }) });
    if (res.ok) {
      const url = URL.createObjectURL(await res.blob());
      const audio = new Audio(url);
      current = { stop: () => { audio.pause(); URL.revokeObjectURL(url); onEnd?.(); } };
      audio.onended = () => { URL.revokeObjectURL(url); current = null; onEnd?.(); };
      await audio.play();
      return;
    }
    // Fall back to the computer's voice if the cloud fails.
  }
  const u = new SpeechSynthesisUtterance(say);
  const voices = speechSynthesis.getVoices();
  const chosen = voice.startsWith("system:") ? voices.find((v) => v.voiceURI === voice.slice(7)) : undefined;
  const hebrew = /[֐-׿]/.test(say);
  u.voice = chosen ?? voices.find((v) => (hebrew ? /^he|^iw/i.test(v.lang) : v.lang.startsWith(getLocale() === "he" ? "en" : "en"))) ?? null;
  u.lang = u.voice?.lang ?? (hebrew ? "he-IL" : "en-US");
  u.onend = () => { current = null; onEnd?.(); };
  u.onerror = () => { current = null; onEnd?.(); };
  current = { stop: () => { speechSynthesis.cancel(); onEnd?.(); } };
  speechSynthesis.speak(u);
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
    const load = () => setVoices(speechSynthesis.getVoices());
    load();
    speechSynthesis.addEventListener("voiceschanged", load);
    return () => speechSynthesis.removeEventListener("voiceschanged", load);
  }, []);
  const sorted = [...voices].sort((a, b) => Number(/^he|^iw/i.test(b.lang)) - Number(/^he|^iw/i.test(a.lang)) || a.lang.localeCompare(b.lang));
  return (
    <>
      <label className="stack">
        <span>{t("ttsVoice")}</span>
        <select value={voice} onChange={(e) => { setVoice(e.target.value); write(VOICE_KEY, e.target.value); }}>
          <option value="">{t("ttsVoiceAuto")}</option>
          {clouds.includes("openai") && ["alloy", "nova", "shimmer", "echo", "onyx", "sage"].map((v) => <option key={v} value={`cloud:openai:${v}`}>OpenAI · {v}</option>)}
          {sorted.map((v) => <option key={v.voiceURI} value={`system:${v.voiceURI}`}>{v.name} ({v.lang})</option>)}
        </select>
      </label>
      {voices.length > 0 && !voices.some((v) => /^he|^iw/i.test(v.lang)) && <p className="muted small">{t("ttsNoHebrew")}</p>}
      <label className="row tts-auto">
        <input type="checkbox" checked={auto} onChange={(e) => { setAuto(e.target.checked); write(AUTO_KEY, e.target.checked ? "1" : "0"); }} />
        <span>{t("ttsAuto")}</span>
      </label>
      <button type="button" onClick={() => void speak(getLocale() === "he" ? "שלום, ככה אני נשמע." : "Hello, this is how I sound.")}>{t("ttsTry")}</button>
    </>
  );
}

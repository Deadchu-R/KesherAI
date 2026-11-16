import { useEffect, useRef, useState } from "react";
import { withToken } from "./api";
import { getLocale, he$ } from "./i18n";
import { encodeWav } from "./Mic";
import { stamp } from "./study-time";
import { busy } from "./VersionWatch";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);
const PIECE_SEC = 30;

/**
 * Records a lecture (the microphone, and in a Zoom or Teams lesson on the computer also the computer's sound), turns
 * each half minute into text with the computer's speech engine as it goes, and hands the transcript (with minute
 * marks and the ⭐ marks) to be saved as a lecture. The audio itself is not kept. Works on the computer and from the
 * phone through remote.
 *
 * @param props.onDone - Called with the transcript when the recording stops (empty when nothing was said).
 * @param props.onCancel - Called when the person closes it before starting.
 */
export function StudyRecorder({ onDone, onCancel }: { onDone: (text: string) => void; onCancel: () => void }) {
  const [state, setState] = useState<"idle" | "recording" | "paused" | "finishing">("idle");
  const [lines, setLines] = useState<string[]>([]);
  const [secs, setSecs] = useState(0);
  const [error, setError] = useState("");
  const [withSystem, setWithSystem] = useState(false);
  const [awake, setAwake] = useState(true);
  const paused = useRef(false);
  const rec = useRef<{ stop: () => Promise<void>; mark: () => void } | null>(null);
  const canSystem = typeof navigator.mediaDevices?.getDisplayMedia === "function" && !matchMedia("(pointer: coarse)").matches;

  useEffect(() => {
    if (state !== "recording") return;
    const id = setInterval(() => setSecs((x) => x + 1), 1000);
    return () => clearInterval(id);
  }, [state]);
  useEffect(() => () => void rec.current?.stop(), []);
  // Load the speech models now, before class, so the first half minute is not slow.
  useEffect(() => void fetch(withToken("/api/speech/stt/warm"), { method: "POST" }).catch(() => undefined), []);

  const start = async () => {
    setError("");
    let mic: MediaStream;
    try {
      mic = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: false, noiseSuppression: true, autoGainControl: true } });
    } catch {
      setError(L("אין גישה למיקרופון. אשרי גישה למיקרופון ונסי שוב.", "No access to the microphone. Allow it and try again."));
      return;
    }
    let sys: MediaStream | undefined;
    if (withSystem) {
      try {
        sys = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
        sys.getVideoTracks().forEach((t) => t.stop());
        if (!sys.getAudioTracks().length) sys = undefined;
      } catch {
        sys = undefined;
      }
    }
    // Keep the screen from locking (the phone's browser can stop the microphone when it does).
    let lock: { release: () => Promise<void> } | undefined;
    if (awake) lock = await (navigator as Navigator & { wakeLock?: { request: (t: "screen") => Promise<{ release: () => Promise<void> }> } }).wakeLock?.request("screen").catch(() => undefined);
    const ctx = new AudioContext({ sampleRate: 16000 });
    const mute = ctx.createGain();
    mute.gain.value = 0;
    mute.connect(ctx.destination);
    // Both sources go into one channel: the lecturer and the student's own questions together.
    const mix = ctx.createGain();
    ctx.createMediaStreamSource(mic).connect(mix);
    if (sys) ctx.createMediaStreamSource(sys).connect(mix);
    const node = ctx.createScriptProcessor(4096, 1, 1);
    mix.connect(node);
    node.connect(mute);
    const began = Date.now();
    let pausedFor = 0;
    let pausedAt = 0;
    const now = () => (Date.now() - began - pausedFor) / 1000;
    let chunks: Float32Array[] = [];
    let peak = 0;
    let pieceAt = 0;
    let queue = Promise.resolve();
    const flush = () => {
      const wav = chunks.length && peak > 0.015 ? encodeWav(chunks, ctx.sampleRate) : undefined;
      const at = pieceAt;
      chunks = [];
      peak = 0;
      pieceAt = now();
      if (!wav) return;
      queue = queue.then(async () => {
        try {
          const res = await fetch(withToken(`/api/speech/transcribe?lang=auto`), { method: "POST", headers: { "content-type": "audio/wav" }, body: wav });
          const j = (await res.json()) as { text?: string; error?: string; code?: string };
          if (j.code === "needs-setup") throw new Error(L("צריך להגדיר דיבור-לטקסט במחשב: הגדרות ← דיבור.", "Set up speech to text on the computer first: Settings → Speech."));
          if (!res.ok) throw new Error(j.error ?? String(res.status));
          const t = (j.text ?? "").trim();
          if (t) setLines((ls) => [...ls, `${stamp(at)} ${t}`]);
        } catch (e) {
          setError((e as Error).message);
        }
      });
    };
    node.onaudioprocess = (e) => {
      if (paused.current) return;
      const d = e.inputBuffer.getChannelData(0);
      chunks.push(new Float32Array(d));
      for (let i = 0; i < d.length; i += 64) peak = Math.max(peak, Math.abs(d[i]!));
      if (now() - pieceAt >= PIECE_SEC) flush();
    };
    rec.current = {
      mark: () => setLines((ls) => [...ls, `${stamp(now())} ⭐ ${L("חשוב", "Important")}`]),
      stop: async () => {
        rec.current = null;
        busy.recording = false;
        flush();
        node.disconnect();
        [mic, sys].forEach((st) => st?.getTracks().forEach((t) => t.stop()));
        void ctx.close();
        void lock?.release().catch(() => undefined);
        setState("finishing");
        await queue;
        setLines((ls) => {
          onDone(ls.join("\n"));
          return ls;
        });
      },
    };
    // Pausing: the clock and the recording stop together.
    pauseToggle.current = () => {
      paused.current = !paused.current;
      if (paused.current) {
        flush();
        pausedAt = Date.now();
        setState("paused");
      } else {
        pausedFor += Date.now() - pausedAt;
        pieceAt = now();
        setState("recording");
      }
    };
    busy.recording = true;
    setSecs(0);
    setLines([]);
    setState("recording");
  };
  const pauseToggle = useRef<() => void>(() => undefined);

  if (state === "idle")
    return (
      <section className="card study-recorder">
        <h2>{L("הקלטת הרצאה", "Record a lecture")}</h2>
        <p className="muted small">{L("כל חצי דקה הופכת לטקסט במחשב, בזמן ההקלטה. בסוף נשמרת הרצאה עם התמלול והדקות. ההקלטה עצמה לא נשמרת.", "Every half minute becomes text on the computer while you record. At the end a lecture is saved with the transcript and minutes. The audio itself is not kept.")}</p>
        {canSystem && <label className="study-check"><input type="checkbox" checked={withSystem} onChange={(e) => setWithSystem(e.target.checked)} /> {L("שיעור בזום או ב-Teams: להקליט גם את הקול של המחשב", "A Zoom or Teams lesson: also record the computer's sound")}</label>}
        <label className="study-check"><input type="checkbox" checked={awake} onChange={(e) => setAwake(e.target.checked)} /> {L("להשאיר את המסך דלוק (בטלפון, מסך כבוי יכול לעצור את ההקלטה)", "Keep the screen on (on a phone, a locked screen can stop the recording)")}</label>
        <p className="muted small">{L("לפני שמקליטים שיעור, כדאי לוודא שהמרצה מסכים/ה.", "Before recording a class, make sure the lecturer agrees.")}</p>
        {error && <p className="error small">{error}</p>}
        <div className="study-actions">
          <button type="button" className="primary study-rec-big" onClick={() => void start()}>{L("התחל הקלטה", "Start recording")}</button>
          <button type="button" className="ghost" onClick={onCancel}>{L("ביטול", "Cancel")}</button>
        </div>
      </section>
    );
  const mm = Math.floor(secs / 60);
  return (
    <section className="card study-recorder">
      <p className={`study-rec-state ${state === "recording" ? "on" : ""}`}>{state === "recording" ? L("● מקליט", "● Recording") : state === "paused" ? L("מושהה", "Paused") : L("מסיים את התמלול…", "Finishing the transcript…")}</p>
      <p className="study-rec-clock" dir="ltr">{Math.floor(mm / 60) ? `${Math.floor(mm / 60)}:` : ""}{String(mm % 60).padStart(2, "0")}:{String(secs % 60).padStart(2, "0")}</p>
      <div className="study-rec-text" dir="auto" aria-live="polite">{lines.length ? lines.slice(-6).join("\n") : L("התמלול יופיע כאן אחרי חצי הדקה הראשונה.", "The transcript shows here after the first half minute.")}</div>
      {error && <p className="error small">{error}</p>}
      {state !== "finishing" && (
        <div className="study-actions">
          <button type="button" onClick={() => rec.current?.mark()}>⭐ {L("חשוב", "Important")}</button>
          <button type="button" onClick={() => pauseToggle.current()}>{state === "paused" ? L("המשך", "Resume") : L("השהה", "Pause")}</button>
          <button type="button" className="danger study-rec-big" onClick={() => void rec.current?.stop()}>{L("סיים הקלטה", "Finish recording")}</button>
        </div>
      )}
    </section>
  );
}

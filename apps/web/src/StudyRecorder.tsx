import { useEffect, useRef, useState } from "react";
import { api, withToken } from "./api";
import { getLocale, he$ } from "./i18n";
import { encodeWav } from "./Mic";
import { stamp, stampSeconds } from "./study-time";
import { busy } from "./VersionWatch";
import { openMic } from "./mic-access";
import { useLongRecorder } from "./long-recorder";
import { RecNote } from "./RecNote";
import type { RecGap } from "./rec-store";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);
const PIECE_SEC = 30;
/** h:mm:ss (or mm:ss under an hour). */
const clockOf = (secs: number) => {
  const mm = Math.floor(secs / 60);
  return `${Math.floor(mm / 60) ? `${Math.floor(mm / 60)}:` : ""}${String(mm % 60).padStart(2, "0")}:${String(secs % 60).padStart(2, "0")}`;
};

/**
 * Records a lecture (the microphone, and in a Zoom or Teams lesson on the computer also the computer's sound), turns
 * each half minute into text with the computer's speech engine as it goes, and hands the transcript (with minute
 * marks and the ⭐ marks) to be saved as a lecture, with the audio when she keeps it. Works on the computer and from the
 * phone through remote.
 *
 * Nothing recorded is lost (useLongRecorder): in the phone app the phone records natively in the background (screen
 * off, another app in front) and each finished half minute is transcribed as it comes; elsewhere the sound is kept in
 * the browser every 5 seconds and the transcript with it, so after a reload or a crash "Resume" goes on into the same
 * lecture, and "Finish" saves what there is.
 *
 * @param props.onDone - Called with the transcript when the recording stops (empty when nothing was said), and the audio
 *   when it is kept.
 * @param props.onCancel - Called when the person closes it before starting.
 */
export function StudyRecorder({ onDone, onCancel, courseId }: { onDone: (text: string, audio?: Blob) => void | Promise<void>; onCancel: () => void; courseId?: string }) {
  // A question during the class, answered from the transcript so far (design LiveAsk, students part 27 #8).
  const [q, setQ] = useState("");
  const [answers, setAnswers] = useState<Array<{ q: string; a?: string }>>([]);
  const askLive = async () => {
    const question = q.trim();
    if (!question || !courseId) return;
    setQ("");
    setAnswers((x) => [...x, { q: question }]);
    const a = await api<{ answer: string }>(`/api/study/courses/${courseId}/ask-live`, { method: "POST", body: { question, transcript: lines.join("\n") } }).then((r) => r.answer, (e: Error) => `⚠ ${e.message}`);
    setAnswers((x) => x.map((y) => (y.q === question && y.a === undefined ? { q: question, a } : y)));
  };
  const [state, setState] = useState<"idle" | "recording" | "paused" | "finishing">("idle");
  const [lines, setLines] = useState<string[]>([]);
  const [secs, setSecs] = useState(0);
  const [error, setError] = useState("");
  const [withSystem, setWithSystem] = useState(false);
  const [awake, setAwake] = useState(true);
  // Keep the audio (Settings → Study decides the default), so a minute mark can play from there.
  const [keep, setKeep] = useState(true);
  useEffect(() => void api<{ keep: boolean }>("/api/study/recordings").then((r) => setKeep(r.keep), () => undefined), []);
  const canKeep = typeof MediaRecorder !== "undefined";
  // Live translation of each half minute ("" off), shown under the transcript; the lecture keeps the original.
  const [translateTo, setTranslateTo] = useState<"" | "he" | "en">("");
  const [translated, setTranslated] = useState<string[]>([]);
  const paused = useRef(false);
  // Transcribes one half minute (WAV) into a line at its minute; in order, one after another.
  const queue = useRef(Promise.resolve());
  const transcribe = (wav: Blob, at: number) => {
    queue.current = queue.current.then(async () => {
      try {
        const res = await fetch(withToken(`/api/speech/transcribe?lang=auto&app=${getLocale()}`), { method: "POST", headers: { "content-type": "audio/wav" }, body: wav });
        const j = (await res.json()) as { text?: string; error?: string; code?: string };
        if (j.code === "needs-setup") throw new Error(L("צריך להגדיר דיבור-לטקסט במחשב: הגדרות ← דיבור.", "Set up speech to text on the computer first: Settings → Speech."));
        if (!res.ok) throw new Error(j.error ?? String(res.status));
        const t = (j.text ?? "").trim();
        if (t) setLines((ls) => [...ls, `${stamp(at)} ${t}`]);
        if (t && translateRef.current) {
          // Not awaited: the next half minute's transcript does not wait for the translation.
          void api<{ text: string }>("/api/study/translate", { method: "POST", body: { text: t, to: translateRef.current } }).then((r) => r.text && setTranslated((ts) => [...ts, `${stamp(at)} ${r.text}`]), () => undefined);
        }
      } catch (e) {
        setError((e as Error).message);
      }
    });
  };
  const translateRef = useRef(translateTo);
  translateRef.current = translateTo;
  // The shared recorder: native in the phone app (pieces come to onPiece), the browser's storage elsewhere.
  const long = useLongRecorder("study", { onPiece: (wav, at) => transcribe(wav, at) });
  const nativeMode = long.native;
  // The transcript goes with the kept recording, so a resumed or finished-later lecture has it.
  useEffect(() => {
    if (state !== "idle" && state !== "finishing") long.setMeta({ lines, keep });
  }, [lines, state]);
  const rec = useRef<{ stop: () => Promise<void>; mark: () => void; slide: (f: File) => void } | null>(null);
  const [slides, setSlides] = useState(0);
  const slideInput = useRef<HTMLInputElement>(null);
  const canSystem = typeof navigator.mediaDevices?.getDisplayMedia === "function" && !matchMedia("(pointer: coarse)").matches;

  useEffect(() => {
    if (state !== "recording" || nativeMode) return;
    const id = setInterval(() => setSecs((x) => x + 1), 1000);
    return () => clearInterval(id);
  }, [state]);
  // Leaving the page saves the page's own recording; the phone app's goes on in the background and is found on return.
  useEffect(() => () => { if (!nativeMode) void rec.current?.stop(); }, [nativeMode]);
  // The phone app: the clock and the pause follow the native recorder (also after coming back from another app).
  useEffect(() => {
    if (!nativeMode) return;
    setSecs(long.secs);
    if (long.status === "recording" || long.status === "silenced") setState((s) => (s === "finishing" ? s : "recording"));
    else if (long.status === "paused") setState("paused");
    else if (long.status === "interrupted") {
      // Stopped from the notification or by the system: the card with Resume and Finish shows.
      rec.current = null;
      busy.recording = false;
      setState((s) => (s === "finishing" ? s : "idle"));
    }
  }, [nativeMode, long.secs, long.status]);
  // Load the speech models now, before class, so the first half minute is not slow.
  useEffect(() => void fetch(withToken("/api/speech/stt/warm"), { method: "POST" }).catch(() => undefined), []);

  const pauseToggle = useRef<() => void>(() => undefined);
  const linesRef = useRef(lines);
  linesRef.current = lines;
  const secsRef = useRef(secs);
  secsRef.current = secs;
  const statusRef = useRef(long.status);
  statusRef.current = long.status;
  // Photos of slides, read on the computer while the recording goes on; each goes in at its minute.
  const reading = useRef<Array<Promise<void>>>([]);
  const slideN = useRef(0);
  const readSlide = (f: File, at: number) => {
    const n = ++slideN.current;
    setSlides(n);
    reading.current.push((async () => {
      let body = L("(השקף לא נקרא)", "(the slide could not be read)");
      try {
        const bytes = new Uint8Array(await f.arrayBuffer());
        let bin = "";
        for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        const r = await api<{ text: string }>("/api/study/extract", { method: "POST", body: { name: f.name || "slide.jpg", data: btoa(bin) } });
        if (r.text.trim()) body = r.text.trim().slice(0, 6000);
      } catch (e) {
        body = `${body} ${(e as Error).message}`;
      }
      setLines((ls) => [...ls, `${stamp(at)} 📸 ${L(`שקף ${n}`, `Slide ${n}`)}:\n${body}`]);
    })());
  };
  const mark = (at: number) => setLines((ls) => [...ls, `${stamp(at)} ⭐ ${L("חשוב", "Important")}`]);

  /**
   * Hands the lecture on once everything is in: the transcript in time order (slides and the gaps where the recording
   * was paused or stopped go in at their minute), and the audio when it is kept. Then the kept recording is removed.
   */
  const finishWith = async (gaps: RecGap[], audio: Blob | undefined) => {
    await queue.current;
    await Promise.all(reading.current);
    const gapLines = gaps.filter((g) => g.ms >= 3000).map((g) => `${stamp(g.at / 1000)} ⏸ ${g.system ? L(`(פער של ${Math.round(g.ms / 1000)} שניות: ההקלטה נעצרה)`, `(a ${Math.round(g.ms / 1000)} s gap: the recording stopped)`) : L(`(הושהה ${Math.round(g.ms / 1000)} שניות)`, `(paused ${Math.round(g.ms / 1000)} s)`)}`);
    const text = [...linesRef.current, ...gapLines].sort((a, b) => stampSeconds(a) - stampSeconds(b)).join("\n");
    await onDone(text, keep && audio && audio.size > 1000 ? audio : undefined);
    await long.done();
  };

  /** The phone app: the native recorder does the recording; the page marks, reads slides, pauses and stops it. */
  const attachNative = () => {
    rec.current = {
      mark: () => mark(secsRef.current),
      slide: (f) => readSlide(f, secsRef.current),
      stop: async () => {
        rec.current = null;
        busy.recording = false;
        setState("finishing");
        const take = await long.finish().catch((e: Error) => (setError(e.message), undefined));
        await finishWith(take?.gaps ?? [], take?.audio);
      },
    };
    pauseToggle.current = () => void long.pause(statusRef.current !== "paused");
    busy.recording = true;
  };
  // Coming back to the page while the phone app still records: the transcript so far, and the controls.
  useEffect(() => {
    if (!nativeMode || state !== "idle" || (long.status !== "recording" && long.status !== "paused" && long.status !== "silenced")) return;
    setLines(((long.getMeta().lines as string[] | undefined) ?? []).slice());
    attachNative();
    setState(long.status === "paused" ? "paused" : "recording");
  }, [nativeMode, long.status]);

  /** Finishes a recording that stopped without the page (from its kept transcript and sound). */
  const finishKept = async () => {
    setLines(((long.pending?.meta.lines as string[] | undefined) ?? []).slice());
    setState("finishing");
    const take = await long.finish().catch((e: Error) => (setError(e.message), undefined));
    await finishWith(take?.gaps ?? [], take?.audio);
  };

  /** Starts recording, or (resume) goes on into the recording that stopped, with its transcript and clock. */
  const start = async (resume = false) => {
    setError("");
    const kept = resume ? long.pending : null;
    const base = kept?.seconds ?? 0;
    const keptLines = ((kept?.meta.lines as string[] | undefined) ?? []).slice();
    if (nativeMode) {
      try {
        if (resume) await long.resume();
        else if (!(await long.start(undefined, { lines: [], keep }))) return setError(L("הקלטה אחרת (מוח פתוח) עדיין שמורה בטלפון. סיימו אותה קודם.", "Another recording (Open mind) is still kept on the phone. Finish it first."));
      } catch (e) {
        return setError((e as Error).message);
      }
      attachNative();
      setLines(keptLines);
      setSecs(base);
      setState("recording");
      return;
    }
    let mic: MediaStream;
    try {
      mic = await openMic({ channelCount: 1, echoCancellation: false, noiseSuppression: true, autoGainControl: true });
    } catch (e) {
      setError((e as Error).message);
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
    // The sound, Opus in WebM at speech quality, kept in the browser every 5 seconds (useLongRecorder) so nothing is
    // lost; it goes to the computer at the end when she keeps it.
    if (canKeep) {
      try {
        const dest = ctx.createMediaStreamDestination();
        mix.connect(dest);
        if (resume) await long.resume(dest.stream);
        else await long.start(dest.stream, { lines: [], keep });
      } catch {
        // without MediaRecorder the transcript still goes on
      }
    }
    const node = ctx.createScriptProcessor(4096, 1, 1);
    mix.connect(node);
    node.connect(mute);
    const began = Date.now();
    let pausedFor = 0;
    let pausedAt = 0;
    const now = () => base + (Date.now() - began - pausedFor) / 1000;
    let chunks: Float32Array[] = [];
    let peak = 0;
    let pieceAt = now();
    const flush = () => {
      const wav = chunks.length && peak > 0.015 ? encodeWav(chunks, ctx.sampleRate) : undefined;
      const at = pieceAt;
      chunks = [];
      peak = 0;
      pieceAt = now();
      if (wav) transcribe(wav, at);
    };
    node.onaudioprocess = (e) => {
      if (paused.current) return;
      const d = e.inputBuffer.getChannelData(0);
      chunks.push(new Float32Array(d));
      for (let i = 0; i < d.length; i += 64) peak = Math.max(peak, Math.abs(d[i]!));
      if (now() - pieceAt >= PIECE_SEC) flush();
    };
    rec.current = {
      mark: () => mark(now()),
      slide: (f) => readSlide(f, now()),
      stop: async () => {
        rec.current = null;
        busy.recording = false;
        flush();
        node.disconnect();
        setState("finishing");
        const take = canKeep ? await long.finish().catch(() => undefined) : undefined;
        [mic, sys].forEach((st) => st?.getTracks().forEach((t) => t.stop()));
        void ctx.close();
        void lock?.release().catch(() => undefined);
        await finishWith(take?.gaps ?? [], take?.audio);
      },
    };
    // Pausing: the clock and the recording stop together.
    pauseToggle.current = () => {
      paused.current = !paused.current;
      if (paused.current) {
        flush();
        void long.pause(true).catch(() => undefined);
        pausedAt = Date.now();
        setState("paused");
      } else {
        pausedFor += Date.now() - pausedAt;
        void long.pause(false).catch(() => undefined);
        pieceAt = now();
        setState("recording");
      }
    };
    busy.recording = true;
    setSecs(base);
    setLines(keptLines);
    setState("recording");
  };

  if (state === "idle" && long.status === "interrupted" && long.pending)
    return (
      <section className="card study-recorder">
        <h2>{L("הקלטה שנעצרה", "A recording that stopped")}</h2>
        <p className="study-rec-clock" dir="ltr">{clockOf(long.pending.seconds)}</p>
        <RecNote status="interrupted" native={nativeMode} />
        <p className="muted small">{L(`${((long.pending.meta.lines as string[] | undefined) ?? []).length} שורות תמלול שמורות.`, `${((long.pending.meta.lines as string[] | undefined) ?? []).length} transcript lines are kept.`)}</p>
        {error && <p className="error small">{error}</p>}
        <div className="study-actions">
          <button type="button" className="primary study-rec-big" onClick={() => void start(true)}>▶ {L("להמשיך להקליט", "Resume recording")}</button>
          <button type="button" onClick={() => void finishKept()}>{L("לסיים ולשמור הרצאה", "Finish and save the lecture")}</button>
          <button type="button" className="ghost" onClick={() => confirm(L("למחוק את ההקלטה?", "Delete the recording?")) && void long.done()}>{L("למחוק", "Delete")}</button>
        </div>
      </section>
    );
  if (state === "idle")
    return (
      <section className="card study-recorder">
        <h2>{L("הקלטת הרצאה", "Record a lecture")}</h2>
        <p className="muted small">{L("כל חצי דקה הופכת לטקסט במחשב, בזמן ההקלטה. בסוף נשמרת הרצאה עם התמלול והדקות.", "Every half minute becomes text on the computer while you record. At the end a lecture is saved with the transcript and minutes.")}</p>
        {canKeep && <label className="study-check"><input type="checkbox" checked={keep} onChange={(e) => setKeep(e.target.checked)} /> {L("לשמור את ההקלטה (לנגן מכל הערה או דקה)", "Keep the recording (play from any note or minute)")}</label>}
        {canSystem && <label className="study-check"><input type="checkbox" checked={withSystem} onChange={(e) => setWithSystem(e.target.checked)} /> {L("שיעור בזום או ב-Teams: להקליט גם את הקול של המחשב", "A Zoom or Teams lesson: also record the computer's sound")}</label>}
        <label className="study-check">{L("תרגום חי: ", "Live translation: ")}
          <select value={translateTo} onChange={(e) => setTranslateTo(e.target.value as "" | "he" | "en")}>
            <option value="">{L("בלי", "Off")}</option>
            <option value="en">{L("לאנגלית", "To English")}</option>
            <option value="he">{L("לעברית", "To Hebrew")}</option>
          </select>
        </label>
        {!nativeMode && <label className="study-check"><input type="checkbox" checked={awake} onChange={(e) => setAwake(e.target.checked)} /> {L("להשאיר את המסך דלוק (בטלפון, מסך כבוי יכול לעצור את ההקלטה)", "Keep the screen on (on a phone, a locked screen can stop the recording)")}</label>}
        <p className="muted small">{L("לפני שמקליטים שיעור, כדאי לוודא שהמרצה מסכים/ה.", "Before recording a class, make sure the lecturer agrees.")}</p>
        {error && <p className="error small">{error}</p>}
        <div className="study-actions">
          <button type="button" className="primary study-rec-big" onClick={() => void start(false)}>{L("התחל הקלטה", "Start recording")}</button>
          <button type="button" className="ghost" onClick={onCancel}>{L("ביטול", "Cancel")}</button>
        </div>
      </section>
    );
  return (
    <section className="card study-recorder">
      <p className={`study-rec-state ${state === "recording" ? "on" : ""}`}>{state === "recording" ? L("● מקליט", "● Recording") : state === "paused" ? L("מושהה", "Paused") : L("מסיים את התמלול…", "Finishing the transcript…")}</p>
      <p className="study-rec-clock" dir="ltr">{clockOf(secs)}</p>
      <RecNote status={long.status === "silenced" ? "silenced" : state === "recording" ? "recording" : "idle"} native={nativeMode} />
      <div className="study-rec-text" dir="auto" aria-live="polite">{lines.length ? lines.slice(-6).join("\n") : L("התמלול יופיע כאן אחרי חצי הדקה הראשונה.", "The transcript shows here after the first half minute.")}</div>
      {translateTo && <div className="study-rec-text study-rec-trans" dir={translateTo === "he" ? "rtl" : "ltr"} aria-live="polite" aria-label={L("תרגום", "Translation")}>{translated.length ? translated.slice(-6).join("\n") : L("התרגום מגיע כמה שניות אחרי כל קטע.", "The translation follows a few seconds after each piece.")}</div>}
      {courseId && state !== "finishing" && (
        <div className="study-rec-ask">
          {answers.slice(-3).map((x, i) => <p key={i} className="small" dir="auto"><b>{x.q}</b><br />{x.a ?? L("מחפש בתמלול…", "Looking in the transcript…")}</p>)}
          <form className="row" onSubmit={(e) => { e.preventDefault(); void askLive(); }}>
            <input dir="auto" value={q} onChange={(e) => setQ(e.target.value)} placeholder={L("לשאול על מה שנאמר: \"מה הוא אמר על…?\"", "Ask about what was said: \"what did he say about…?\"")} aria-label={L("שאלה על השיעור", "A question about the class")} />
            <button type="submit" disabled={!q.trim() || !lines.length}>{L("לשאול", "Ask")}</button>
          </form>
        </div>
      )}
      {error && <p className="error small">{error}</p>}
      {state !== "finishing" && (
        <div className="study-actions">
          <button type="button" onClick={() => rec.current?.mark()}>⭐ {L("חשוב", "Important")}</button>
          <button type="button" onClick={() => slideInput.current?.click()}>📸 {slides ? L(`שקף (${slides})`, `Slide (${slides})`) : L("צילום שקף", "Photo of a slide")}</button>
          <input ref={slideInput} type="file" accept="image/*" capture="environment" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) rec.current?.slide(f); }} />
          <button type="button" onClick={() => pauseToggle.current()}>{state === "paused" ? L("המשך", "Resume") : L("השהה", "Pause")}</button>
          <button type="button" className="danger study-rec-big" onClick={() => void rec.current?.stop()}>{L("סיים הקלטה", "Finish recording")}</button>
        </div>
      )}
    </section>
  );
}

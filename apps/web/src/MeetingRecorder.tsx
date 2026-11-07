import { useEffect, useRef, useState } from "react";
import { api, withToken } from "./api";
import { getLocale } from "./i18n";
import { encodeWav } from "./Mic";
import { toast } from "./library";

const L = (he: string, en: string) => (getLocale() === "he" ? he : en);
const PIECE_SEC = 30;

interface Started { day: string; meeting: { id: string } }

/**
 * Records a meeting: your microphone plus the call's sound (the desktop app
 * captures what the computer plays), turns each half minute into text with
 * the speech engine (the microphone and the call apart, so it knows who
 * spoke: you or the others), and when you stop, the model writes the summary,
 * decisions and action items. Nothing leaves this computer unless your
 * speech or chat engine is a cloud one.
 *
 * @param props.suggestedTitle - The call window's title, if one is in front.
 * @param props.onDone - Called with the meeting's day when it is written up.
 */
export function MeetingRecorder({ suggestedTitle, onDone }: { suggestedTitle?: string; onDone: (day: string) => void }) {
  const [state, setState] = useState<"idle" | "asking" | "recording" | "finishing">("idle");
  const [title, setTitle] = useState(suggestedTitle ?? "");
  const [secs, setSecs] = useState(0);
  const [pieces, setPieces] = useState({ sent: 0, done: 0 });
  const [callSound, setCallSound] = useState(true);
  const [error, setError] = useState("");
  const rec = useRef<{ stop: () => Promise<void> } | null>(null);

  useEffect(() => {
    if (state !== "recording") return;
    const id = setInterval(() => setSecs((x) => x + 1), 1000);
    return () => clearInterval(id);
  }, [state]);
  useEffect(() => () => void rec.current?.stop(), []);

  const start = async () => {
    setError("");
    let mic: MediaStream;
    try {
      mic = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
    } catch {
      setError(L("אין גישה למיקרופון.", "No access to the microphone."));
      return;
    }
    // The call's sound: the desktop app grants the screen's audio ("loopback"); we drop the picture.
    let sys: MediaStream | undefined;
    try {
      sys = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      sys.getVideoTracks().forEach((t) => t.stop());
      if (!sys.getAudioTracks().length) sys = undefined;
    } catch {
      sys = undefined;
    }
    setCallSound(!!sys);
    const started = await api<Started>("/api/journal/meetings", { method: "POST", body: { title: title || L("פגישה", "Meeting") } });
    const ctx = new AudioContext({ sampleRate: 16000 });
    const mute = ctx.createGain();
    mute.gain.value = 0; // record without playing the call back through the speakers
    mute.connect(ctx.destination);
    let queue = Promise.resolve();
    // The microphone and the call's sound are transcribed apart, so the transcript tells "Me" from "Others".
    const channel = (stream: MediaStream, who: "me" | "others" | undefined) => {
      const src = ctx.createMediaStreamSource(stream);
      const node = ctx.createScriptProcessor(4096, 1, 1);
      src.connect(node);
      node.connect(mute);
      let chunks: Float32Array[] = [];
      let peak = 0;
      let pieceStart = Date.now();
      const flush = () => {
        const loud = peak > 0.02;
        const wav = chunks.length && loud ? encodeWav(chunks, ctx.sampleRate) : undefined;
        const t = pieceStart;
        chunks = [];
        peak = 0;
        pieceStart = Date.now();
        if (!wav) return; // silence: nothing to transcribe
        setPieces((p) => ({ ...p, sent: p.sent + 1 }));
        queue = queue.then(async () => {
          try {
            const res = await fetch(withToken("/api/speech/transcribe"), { method: "POST", headers: { "content-type": "audio/wav" }, body: wav });
            const j = (await res.json()) as { text?: string; error?: string; code?: string };
            if (j.code === "needs-setup") throw new Error(L("צריך להגדיר דיבור-לטקסט: הגדרות ← דיבור.", "Set up speech to text first: Settings → Speech."));
            if (!res.ok) throw new Error(j.error ?? String(res.status));
            if (j.text?.trim()) await api(`/api/journal/meetings/${started.day}/${started.meeting.id}/segment`, { method: "POST", body: { t, text: j.text, ...(who ? { who } : {}) } });
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setPieces((p) => ({ ...p, done: p.done + 1 }));
          }
        });
      };
      node.onaudioprocess = (e) => {
        const d = e.inputBuffer.getChannelData(0);
        chunks.push(new Float32Array(d));
        for (let i = 0; i < d.length; i += 64) peak = Math.max(peak, Math.abs(d[i]!));
        if (Date.now() - pieceStart >= PIECE_SEC * 1000) flush();
      };
      return { flush, stop: () => { node.disconnect(); src.disconnect(); } };
    };
    // Without the call's sound, the microphone hears everyone in the room: no labels then.
    const channels = [channel(mic, sys ? "me" : undefined), ...(sys ? [channel(sys, "others")] : [])];
    rec.current = {
      stop: async () => {
        rec.current = null;
        channels.forEach((c) => { c.flush(); c.stop(); });
        [mic, sys].forEach((st) => st?.getTracks().forEach((t) => t.stop()));
        void ctx.close();
        setState("finishing");
        await queue;
        try {
          await api(`/api/journal/meetings/${started.day}/${started.meeting.id}/finish`, { method: "POST", body: {} });
          toast(L("הפגישה סוכמה", "The meeting is written up"));
        } catch (e) {
          setError((e as Error).message);
        }
        setState("idle");
        setSecs(0);
        setPieces({ sent: 0, done: 0 });
        onDone(started.day);
      },
    };
    setSecs(0);
    setState("recording");
  };

  if (state === "idle")
    return (
      <>
        <button type="button" onClick={() => { setTitle(suggestedTitle ?? ""); setState("asking"); }}>{L("הקלט פגישה", "Record a meeting")}</button>
        {error && <span className="error small">{error}</span>}
      </>
    );
  if (state === "asking")
    return (
      <div className="dialog-backdrop" role="presentation" onClick={() => setState("idle")}>
        <form className="dialog card stack" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); void start(); }}>
          <strong>{L("הקלטת פגישה", "Record a meeting")}</strong>
          <p className="muted small">{L("מקליט את המיקרופון ואת הקול של השיחה, הופך כל חצי דקה לטקסט, ובסוף כותב סיכום, החלטות ומשימות. ההקלטה עצמה לא נשמרת, רק הטקסט.", "Records your microphone and the call's sound, turns each half minute into text, and at the end writes a summary, decisions and action items. The audio itself is not kept, only the text.")}</p>
          <p className="small">{L("ספר למשתתפים שאתה מקליט.", "Tell the other people you are recording.")}</p>
          <label className="stack"><span>{L("שם הפגישה", "Meeting name")}</span><input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={L("למשל: סנכרון שבועי", "e.g. Weekly sync")} /></label>
          {error && <p className="error small">{error}</p>}
          <div className="row" style={{ justifyContent: "flex-end" }}>
            <button type="button" onClick={() => setState("idle")}>{L("ביטול", "Cancel")}</button>
            <button type="submit" className="primary">{L("התחל להקליט", "Start recording")}</button>
          </div>
        </form>
      </div>
    );
  return (
    <div className="meeting-rec" role="status">
      <span className="rec-dot" aria-hidden />
      <strong dir="ltr">{Math.floor(secs / 60)}:{String(secs % 60).padStart(2, "0")}</strong>
      <span className="muted small">
        {state === "finishing" ? L("כותב את הסיכום…", "Writing it up…") : callSound ? L("מקליט אותך ואת השיחה", "Recording you and the call") : L("מקליט רק את המיקרופון", "Recording the microphone only")}
        {pieces.sent > pieces.done ? L(` · מתמלל ${pieces.sent - pieces.done}`, ` · transcribing ${pieces.sent - pieces.done}`) : ""}
      </span>
      {state === "recording" && <button type="button" className="primary" onClick={() => void rec.current?.stop()}>{L("עצור וסכם", "Stop and write up")}</button>}
      {error && <span className="error small">{error}</span>}
    </div>
  );
}

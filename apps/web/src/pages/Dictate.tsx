import { useEffect, useRef, useState } from "react";
import { withToken } from "../api";
import { getLocale, he$ } from "../i18n";
import { desktop } from "../library";
import { encodeWav } from "../Mic";
import { hearFrame, type SilenceState } from "../dictate-silence";
import { LineIcon } from "../ui/Glyph";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);

/** The longest dictation. */
const MAX_SECONDS = 120;

/**
 * The dictation bar (`#/dictate`, Ctrl+Alt+D over any app): listens at once, stops on the key again, on a two-second
 * pause after speech, or at two minutes; Whisper on this computer turns it into text, which is typed where the
 * cursor was. The window never takes the focus, so the other app keeps its cursor.
 */
export function Dictate() {
  const [state, setState] = useState<"starting" | "listening" | "working" | "error">("starting");
  const [secs, setSecs] = useState(0);
  const [level, setLevel] = useState(0);
  const [error, setError] = useState("");
  const finish = useRef<(keep: boolean) => void>(() => undefined);
  const bridge = desktop();

  // The current listening, so a new one (the key pressed again while the bar is hidden) ends it first.
  const endCurrent = useRef<() => void>(() => undefined);

  /** Starts listening: when the bar opens, and each time the key is pressed again later (the bar stays loaded). */
  const begin = () => {
    endCurrent.current();
    setState("starting");
    setSecs(0);
    setLevel(0);
    setError("");
    let stopped = false;
    let cleanup = () => undefined as void;
    endCurrent.current = () => {
      stopped = true;
      cleanup();
    };
    const close = (text = "") => void bridge?.dictateDone?.(text);
    void (async () => {
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
      } catch {
        setError(L("אין גישה למיקרופון", "No access to the microphone"));
        setState("error");
        return;
      }
      // Ended (a new press) while the microphone was opening: let it go.
      if (stopped) return stream.getTracks().forEach((t) => t.stop());
      const ctx = new AudioContext({ sampleRate: 16000 });
      const src = ctx.createMediaStreamSource(stream);
      const node = ctx.createScriptProcessor(4096, 1, 1);
      const chunks: Float32Array[] = [];
      const frameMs = (4096 / ctx.sampleRate) * 1000;
      let heard: SilenceState = { spoke: 0, quietMs: 0 };
      node.onaudioprocess = (e) => {
        const d = e.inputBuffer.getChannelData(0);
        chunks.push(new Float32Array(d));
        let peak = 0;
        for (let i = 0; i < d.length; i += 64) peak = Math.max(peak, Math.abs(d[i]!));
        setLevel(peak);
        const r = hearFrame(heard, peak, frameMs);
        heard = r.state;
        if (r.stop) finish.current(true);
      };
      src.connect(node);
      node.connect(ctx.destination);
      let elapsed = 0;
      const tick = window.setInterval(() => {
        elapsed++;
        setSecs(elapsed);
        if (elapsed >= MAX_SECONDS) finish.current(true);
      }, 1000);
      setState("listening");
      cleanup = () => {
        window.clearInterval(tick);
        node.disconnect();
        src.disconnect();
        stream.getTracks().forEach((t) => t.stop());
        void ctx.close();
      };
      finish.current = (keep: boolean) => {
        if (stopped) return;
        stopped = true;
        const rate = ctx.sampleRate;
        cleanup();
        if (!keep || !chunks.length || heard.spoke < 2) return close();
        setState("working");
        void (async () => {
          try {
            const res = await fetch(withToken("/api/speech/transcribe"), { method: "POST", headers: { "content-type": "audio/wav" }, body: encodeWav(chunks, rate) });
            const j = (await res.json()) as { text?: string; error?: string; code?: string };
            if (j.code === "needs-setup") throw new Error(L("צריך להתקין זיהוי דיבור: הגדרות ← דיבור", "Speech recognition needs setting up: Settings → Speech"));
            if (!res.ok) throw new Error(j.error ?? String(res.status));
            close(j.text ?? "");
          } catch (e) {
            setError((e as Error).message);
            setState("error");
          }
        })();
      };
    })();
  };

  useEffect(() => {
    begin();
    const offStop = bridge?.onDictateStop?.(() => finish.current(true));
    const offStart = bridge?.onDictateStart?.(() => begin());
    return () => {
      offStop?.();
      offStart?.();
      endCurrent.current();
    };
    // Once: the bar stays loaded, and `begin` runs again on each new press.
  }, []);

  const mm = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
  return (
    <div className="dictate" role="status" aria-live="polite">
      {state === "error" ? (
        <>
          <span className="dictate-msg grow" dir="auto">{error}</span>
          <button type="button" className="icon-btn" onClick={() => void bridge?.dictateDone?.("")} aria-label={L("סגירה", "Close")}><LineIcon name="close" size={16} /></button>
        </>
      ) : (
        <>
          <span className={`dictate-dot${state === "listening" ? " on" : ""}`} style={{ transform: `scale(${1 + Math.min(1, level * 4)})` }} aria-hidden="true" />
          <span className="dictate-msg grow">
            {state === "working" ? L("כותב…", "Writing…") : state === "starting" ? L("מתחיל…", "Starting…") : L("מקשיב… Ctrl+Alt+D לסיום", "Listening… Ctrl+Alt+D to finish")}
          </span>
          {state === "listening" && <span className="dictate-time">{mm}</span>}
          {state === "listening" && (
            <button type="button" className="primary" onClick={() => finish.current(true)}>{L("סיום", "Done")}</button>
          )}
          <button type="button" className="icon-btn" onClick={() => (state === "listening" ? finish.current(false) : void bridge?.dictateDone?.(""))} aria-label={L("ביטול", "Cancel")} title={L("ביטול", "Cancel")}><LineIcon name="close" size={16} /></button>
        </>
      )}
    </div>
  );
}

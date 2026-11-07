import { useEffect, useRef, useState } from "react";
import { api, withToken } from "./api";
import { toast } from "./library";
import { getLocale, t } from "./i18n";

interface SttInfo {
  choice: string;
  language: string;
  local: { engine: boolean; model?: string; recommended: { label: string; sizeGb: number }; busy?: string; error?: string; localPossible: boolean };
  clouds: Array<{ id: string; label: string }>;
}

/** Encodes mono float samples as a 16-bit PCM WAV file. */
export function encodeWav(chunks: Float32Array[], rate: number): Blob {
  const n = chunks.reduce((a, c) => a + c.length, 0);
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const str = (o: number, s: string) => [...s].forEach((ch, i) => v.setUint8(o + i, ch.charCodeAt(0)));
  str(0, "RIFF");
  v.setUint32(4, 36 + n * 2, true);
  str(8, "WAVEfmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, "data");
  v.setUint32(40, n * 2, true);
  let o = 44;
  for (const c of chunks) for (const x of c) { v.setInt16(o, Math.max(-1, Math.min(1, x)) * 0x7fff, true); o += 2; }
  return new Blob([buf], { type: "audio/wav" });
}

/** The Android app's native speech recognizer, when the page runs inside it. */
type NativeSpeech = { start(o: { language?: string }): Promise<{ text: string }>; stop(): Promise<void> };
const native = (): NativeSpeech | undefined => (window as unknown as { Capacitor?: { Plugins?: { KesherSpeech?: NativeSpeech } } }).Capacitor?.Plugins?.KesherSpeech;

/**
 * The microphone button: tap to talk, tap again to stop; the words go into
 * the message box. Uses whisper.cpp on the computer (set up once, with
 * consent), or a connected cloud service, or the phone's own recognizer in
 * the Android app.
 *
 * @param props.onText - Receives the recognized text.
 */
export function Mic({ onText }: { onText: (text: string) => void }) {
  const [state, setState] = useState<"idle" | "recording" | "working">("idle");
  const [secs, setSecs] = useState(0);
  const [level, setLevel] = useState(0);
  const [setup, setSetup] = useState<SttInfo | null>(null);
  const rec = useRef<{ stop: () => void; cancel: () => void } | null>(null);

  useEffect(() => {
    if (state !== "recording") return;
    const id = setInterval(() => setSecs((x) => x + 1), 1000);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && rec.current?.cancel();
    addEventListener("keydown", esc);
    return () => {
      clearInterval(id);
      removeEventListener("keydown", esc);
    };
  }, [state]);

  // The language set under Settings → Speech wins; the server uses it when none is sent.
  const lang = () => "";

  const send = async (wav: Blob) => {
    setState("working");
    try {
      const res = await fetch(withToken(`/api/speech/transcribe${lang() ? `?lang=${lang()}` : ""}`), { method: "POST", headers: { "content-type": "audio/wav" }, body: wav });
      const j = (await res.json()) as { text?: string; error?: string; code?: string };
      if (j.code === "needs-setup") {
        setSetup(await api<SttInfo>("/api/speech/stt"));
        return;
      }
      if (!res.ok) throw new Error(j.error ?? String(res.status));
      if (j.text) onText(j.text);
      else toast(t("micNothing"));
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setState("idle");
    }
  };

  const start = async () => {
    const n = native();
    if (n) {
      // Inside the Android app: the phone recognizes speech itself.
      setState("recording");
      setSecs(0);
      rec.current = { stop: () => void n.stop(), cancel: () => void n.stop() };
      try {
        const r = await n.start({ language: getLocale() === "he" ? "he-IL" : "" });
        if (r.text) onText(r.text);
      } catch (e) {
        toast((e as Error).message);
      } finally {
        setState("idle");
      }
      return;
    }
    // Before recording, make sure something can turn it into text.
    const info = await api<SttInfo>("/api/speech/stt").catch(() => null);
    if (info && !(info.local.engine && info.local.model) && !(info.choice.startsWith("cloud:") || (info.choice === "auto" && info.clouds.length))) {
      setSetup(info);
      return;
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
    } catch {
      toast(t("micDenied"));
      return;
    }
    const ctx = new AudioContext({ sampleRate: 16000 });
    const src = ctx.createMediaStreamSource(stream);
    const node = ctx.createScriptProcessor(4096, 1, 1);
    const chunks: Float32Array[] = [];
    node.onaudioprocess = (e) => {
      const d = e.inputBuffer.getChannelData(0);
      chunks.push(new Float32Array(d));
      let peak = 0;
      for (let i = 0; i < d.length; i += 64) peak = Math.max(peak, Math.abs(d[i]!));
      setLevel(peak);
    };
    src.connect(node);
    node.connect(ctx.destination);
    const finish = (keep: boolean) => {
      node.disconnect();
      src.disconnect();
      stream.getTracks().forEach((tr) => tr.stop());
      const rate = ctx.sampleRate;
      void ctx.close();
      rec.current = null;
      if (keep && chunks.length) void send(encodeWav(chunks, rate));
      else setState("idle");
    };
    rec.current = { stop: () => finish(true), cancel: () => finish(false) };
    setSecs(0);
    setState("recording");
  };

  const prepare = async () => {
    await api("/api/speech/stt/setup", { method: "POST" }).catch((e: Error) => toast(e.message));
    toast(t("micPreparing"));
    setSetup(null);
  };

  return (
    <>
      <button
        type="button"
        className={`chip mic ${state}`}
        aria-pressed={state === "recording"}
        aria-label={state === "recording" ? t("micStop") : t("micStart")}
        title={state === "recording" ? t("micStop") : t("micStart")}
        disabled={state === "working"}
        onClick={() => (state === "recording" ? rec.current?.stop() : void start())}
        style={state === "recording" ? ({ "--lvl": String(Math.min(1, level * 3)) } as React.CSSProperties) : undefined}
      >
        {state === "working" ? (
          <span className="spinner" aria-hidden />
        ) : (
          <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true"><rect x="5.5" y="1.5" width="5" height="8.5" rx="2.5" fill={state === "recording" ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.4" /><path d="M3 7.5a5 5 0 0 0 10 0M8 12.5V15" stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinecap="round" /></svg>
        )}
        {state === "recording" && <span className="mic-time" dir="ltr">{Math.floor(secs / 60)}:{String(secs % 60).padStart(2, "0")}</span>}
      </button>
      {setup && (
        <div className="dialog-backdrop" role="presentation" onClick={() => setSetup(null)}>
          <div className="dialog card stack" role="dialog" aria-modal="true" aria-label={t("micSetupTitle")} onClick={(e) => e.stopPropagation()}>
            <strong>{t("micSetupTitle")}</strong>
            {setup.local.localPossible ? (
              <>
                <p className="muted">{t("micSetupText", { model: setup.local.recommended.label, gb: setup.local.recommended.sizeGb.toFixed(1) })}</p>
                {setup.local.busy && <p className="muted small">{t("micPreparing")}</p>}
                {setup.local.error && <p className="error small">{setup.local.error}</p>}
              </>
            ) : (
              <p className="muted">{t("micNoLocal")}</p>
            )}
            {setup.clouds.length > 0 && <p className="muted small">{t("micCloudAvailable", { list: setup.clouds.map((c) => c.label).join(", ") })}</p>}
            <div className="row" style={{ justifyContent: "flex-end" }}>
              <button type="button" onClick={() => setSetup(null)}>{t("cancel")}</button>
              {setup.clouds.length > 0 && <button type="button" onClick={() => void api("/api/speech/stt", { method: "PUT", body: { stt: setup.clouds[0]!.id } }).then(() => { setSetup(null); toast(t("micCloudChosen")); })}>{t("micUseCloud")}</button>}
              {setup.local.localPossible && <button type="button" className="primary" disabled={!!setup.local.busy} onClick={() => void prepare()}>{t("micDownload")}</button>}
              {!setup.local.localPossible && !setup.clouds.length && <a className="btn primary" href="#/connections">{t("micConnect")}</a>}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

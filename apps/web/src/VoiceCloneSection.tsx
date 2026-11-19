import { useEffect, useRef, useState } from "react";
import { api, withToken } from "./api";
import { getLocale, he$ } from "./i18n";
import { toast } from "./library";
import { encodeWav } from "./Mic";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);
interface State { installed: boolean; phase?: string; message?: string; log: string[]; voices: string[]; langs: string[] }

/** A voice of her own: set up Chatterbox once, keep a 10–30 s clip (with consent), and hear text in that voice. */
export function VoiceCloneSection() {
  const [st, setSt] = useState<State | null>(null);
  const [name, setName] = useState("");
  const [consent, setConsent] = useState(false);
  const [recording, setRecording] = useState(0);
  const [text, setText] = useState(getLocale() === "he" ? "שלום, זה הקול שלי בתוך KesherAI." : "Hello, this is my voice in KesherAI.");
  const [lang, setLang] = useState(getLocale() === "he" ? "he" : "en");
  const [busy, setBusy] = useState("");
  const [src, setSrc] = useState("");
  const stopRec = useRef<(() => void) | null>(null);
  const load = () => void api<State>("/api/voice-clone").then(setSt, () => undefined);
  useEffect(() => {
    load();
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, []);
  const keep = async (wav: Blob) => {
    if (!name.trim()) return toast(L("תנו שם לקול.", "Give the voice a name."));
    const r = await fetch(withToken(`/api/voice-clone/voices?name=${encodeURIComponent(name)}&consent=${consent ? "yes" : "no"}`), { method: "POST", headers: { "content-type": "audio/wav" }, body: wav });
    const j = (await r.json()) as { error?: string };
    if (!r.ok) return toast(j.error ?? String(r.status));
    setName("");
    load();
  };
  const record = async () => {
    const mic = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 } }).catch(() => undefined);
    if (!mic) return toast(L("אין גישה למיקרופון.", "No access to the microphone."));
    const ctx = new AudioContext({ sampleRate: 24000 });
    const node = ctx.createScriptProcessor(4096, 1, 1);
    const chunks: Float32Array[] = [];
    node.onaudioprocess = (e) => chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
    ctx.createMediaStreamSource(mic).connect(node);
    node.connect(ctx.destination);
    let left = 20;
    setRecording(left);
    const tick = setInterval(() => { left--; setRecording(left); if (left <= 0) stop(); }, 1000);
    const stop = () => {
      clearInterval(tick);
      node.disconnect();
      mic.getTracks().forEach((t) => t.stop());
      void ctx.close();
      setRecording(0);
      stopRec.current = null;
      void keep(encodeWav(chunks, 24000));
    };
    stopRec.current = stop;
  };
  const say = async (voice: string) => {
    setBusy(voice);
    try {
      // A script (more than a line) is read part by part and kept in the bank of everything made; the parts show
      // on the screen as they are spoken.
      const script = text.trim().length > 200;
      const poll = setInterval(load, 2500);
      const r = await fetch(withToken("/api/voice-clone/say"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ voice, text, lang, keep: script }) }).finally(() => clearInterval(poll));
      if (!r.ok) throw new Error(((await r.json()) as { error?: string }).error ?? String(r.status));
      setSrc(URL.createObjectURL(await r.blob()));
      if (r.headers.get("x-asset-id")) toast(L("ההקלטה נשמרה גם בבנק היצירות", "The recording is also kept in Everything made"));
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy("");
    }
  };
  if (!st) return null;
  return (
    <section className="card stack">
      <h2>{L("קול משלך", "A voice of your own")}</h2>
      <p className="muted">{L("KesherAI מדבר בקול שלך מקטע של 10–30 שניות, גם בעברית (Chatterbox, רישיון MIT). רץ במחשב בלבד.", "KesherAI speaks in your voice from a 10–30 second clip, Hebrew too (Chatterbox, MIT licence). It runs on this computer only.")}</p>
      {!st.installed ? (
        <div className="row wrap">
          <button type="button" className="primary" disabled={st.phase === "installing"} onClick={() => void api("/api/voice-clone/install", { method: "POST" }).then(load)}>{st.phase === "installing" ? L("מתקין… (כ-4GB, פעם אחת)", "Installing… (about 4 GB, once)") : L("להכין את מנוע הקול (כ-4GB, פעם אחת)", "Set up the voice engine (about 4 GB, once)")}</button>
          {st.message && <span className="small muted">{st.message}</span>}
        </div>
      ) : (
        <>
          <div className="row wrap">
            {recording ? <button type="button" className="danger" onClick={() => stopRec.current?.()}>{L(`עצירה (${recording})`, `Stop (${recording})`)}</button> : <button type="button" className="primary" disabled={!name.trim() || !consent} onClick={() => void record()}>{L("● הקלטה (20 שניות)", "● Record (20 seconds)")}</button>}
            <label className="button">{L("קובץ WAV", "A WAV file")}<input type="file" hidden accept=".wav,audio/wav" disabled={!name.trim() || !consent} onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void keep(f); }} /></label>
            <input value={name} dir="auto" placeholder={L("שם הקול", "The voice's name")} aria-label={L("שם הקול", "The voice's name")} onChange={(e) => setName(e.target.value)} />
          </div>
          <label className="row small"><input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} /> {L("זה הקול שלי, או שיש לי אישור מבעל הקול", "This is my voice, or I have the speaker's permission")}</label>
          {st.voices.length > 0 && (
            <div className="stack">
              <textarea className="grow" rows={text.length > 120 ? 8 : 2} maxLength={10000} value={text} dir="auto" aria-label={L("מה לומר: משפט או תסריט שלם", "What to say: a line or a whole script")} placeholder={L("משפט, או תסריט שלם (עד 10,000 תווים; שורה ריקה = הפסקה ארוכה)", "A line, or a whole script (up to 10,000 characters; an empty line = a longer pause)")} onChange={(e) => setText(e.target.value)} />
              <div className="row wrap">
                <span className="small muted grow">{text.trim().length > 200 ? L(`תסריט · כ-${Math.max(1, Math.round(text.trim().length / 900))} דק׳ דיבור · ${text.length}/10,000`, `A script · about ${Math.max(1, Math.round(text.trim().length / 900))} min of speech · ${text.length}/10,000`) : ""}</span>
                <select value={lang} aria-label={L("שפה", "Language")} onChange={(e) => setLang(e.target.value)}>{st.langs.map((l) => <option key={l} value={l}>{l}</option>)}</select>
              </div>
              {busy && st.message && <span className="small muted">{st.message}</span>}
            </div>
          )}
          {st.voices.map((v) => (
            <div key={v} className="row">
              <b className="grow" dir="auto">{v}</b>
              <button type="button" disabled={!!busy} onClick={() => void say(v)}>{busy === v ? L("מדבר… (בפעם הראשונה דקה-שתיים)", "Speaking… (a minute or two the first time)") : text.trim().length > 200 ? L("🎙 להקריא את התסריט", "🎙 Read the script") : L("▶ להשמיע", "▶ Play")}</button>
              <button type="button" className="ghost" onClick={() => { if (confirm(L(`למחוק את הקול "${v}"?`, `Delete the voice "${v}"?`))) void api(`/api/voice-clone/voices/${encodeURIComponent(v)}`, { method: "DELETE" }).then(load); }}>{L("מחיקה", "Delete")}</button>
            </div>
          ))}
          {src && <div className="row wrap"><audio controls autoPlay src={src} /><a className="button" href={src} download={`${(busy || "voice").replace(/\s+/g, "-")}.wav`}>{L("⬇ הורדה", "⬇ Download")}</a></div>}
          {st.phase === "error" && <p className="error small">{st.message}</p>}
        </>
      )}
    </section>
  );
}

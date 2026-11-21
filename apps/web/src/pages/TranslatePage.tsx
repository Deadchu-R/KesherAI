import { useEffect, useState } from "react";
import { api } from "../api";
import { getLocale, he$ } from "../i18n";
import { toast } from "../library";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);

type Via = "chat" | "gemini" | "local";
/** What `GET /api/translate` answers. */
interface TranslatorState {
  which: { via: Via; model: string } | null;
  model: { name: string; sizeGb: number; downloaded: boolean; downloading?: boolean };
  max: number;
}
type Direction = "auto" | "en" | "he";

/** The model kind that translated, in words. */
const viaText = (via: Via | "none") =>
  via === "chat" ? L("מודל הצ'אט הטעון", "the loaded chat model") : via === "gemini" ? L("Gemini (המפתח החינמי)", "Gemini (the free key)") : via === "local" ? L("מודל התרגום הקטן", "the small translation model") : "";

/**
 * The Translate page (`#/translate`, Roee 2026-11-21 "מחולל תרגום"): any text, Hebrew ⇄ English, with KesherAI's
 * translator — the same service that puts image and video prompts into English. Works from the phone too (the PC
 * translates). When no model can translate, it offers the small translation model as a one-click download.
 */
export function TranslatePage() {
  const [state, setState] = useState<TranslatorState | null>(null);
  const [text, setText] = useState("");
  const [dir, setDir] = useState<Direction>("auto");
  const [out, setOut] = useState<{ text: string; via: Via | "none"; to: "en" | "he" } | null>(null);
  const [busy, setBusy] = useState(false);
  const load = () => void api<TranslatorState>("/api/translate").then(setState, () => undefined);
  useEffect(load, []);
  // While the model downloads, look again every 10 s.
  useEffect(() => {
    if (!state?.model.downloading) return;
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, [state?.model.downloading]);

  const translate = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    try {
      setOut(await api<{ text: string; via: Via | "none"; to: "en" | "he" }>("/api/translate", { method: "POST", body: { text, to: dir } }));
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const swap = () => {
    if (!out) return;
    setText(out.text);
    setOut(null);
    setDir(out.to === "en" ? "he" : "en");
  };
  const download = async () => {
    try {
      await api("/api/translate/download", { method: "POST" });
      toast(L("ההורדה התחילה. אפשר לעקוב בעיגול ההורדות.", "The download started. Follow it in the downloads circle."));
      load();
    } catch (e) {
      toast((e as Error).message);
    }
  };
  const copy = () => out && void navigator.clipboard.writeText(out.text).then(() => toast(L("הועתק", "Copied")), () => undefined);
  const max = state?.max ?? 20_000;

  return (
    <div className="page translate">
      <div className="page-head">
        <h1>🌐 {L("תרגום", "Translate")}</h1>
        <p className="muted">{L("עברית ⇄ אנגלית, כל טקסט. אותו מתרגם שמעביר לאנגלית את הבקשות לתמונות ולסרטונים.", "Hebrew ⇄ English, any text. The same translator that puts picture and video requests into English.")}</p>
      </div>

      {state && !state.which && (
        <div className="card stack">
          <strong>{L("אין עכשיו מודל שיכול לתרגם", "No model can translate right now")}</strong>
          <p className="muted small">{L(`אפשר לטעון מודל צ'אט, לחבר את Gemini (מודלים ← חיבורים), או להוריד את ${state.model.name} (${state.model.sizeGb} GB). הוא נטען רק כשצריך לתרגם ויורד מהזיכרון אחרי כמה דקות.`, `Load a chat model, connect Gemini (Models → Connections), or download ${state.model.name} (${state.model.sizeGb} GB). It loads only to translate and leaves memory after a few minutes.`)}</p>
          {state.model.downloading ? (
            <span className="small">⏬ {L("מוריד…", "Downloading…")}</span>
          ) : (
            <button type="button" className="primary" onClick={() => void download()}>{L(`הורדת ${state.model.name}`, `Download ${state.model.name}`)}</button>
          )}
        </div>
      )}

      <div className="row wrap" style={{ gap: 8, alignItems: "center" }}>
        <select value={dir} onChange={(e) => setDir(e.target.value as Direction)} aria-label={L("כיוון", "Direction")}>
          <option value="auto">{L("זיהוי אוטומטי", "Detect")}</option>
          <option value="en">{L("לאנגלית", "To English")}</option>
          <option value="he">{L("לעברית", "To Hebrew")}</option>
        </select>
        <button type="button" className="primary" disabled={busy || !text.trim()} onClick={() => void translate()}>{busy ? L("מתרגם…", "Translating…") : L("תרגום", "Translate")}</button>
        {state?.which && <span className="muted small">{L("מתרגם עם", "Translating with")} {viaText(state.which.via)}</span>}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 300px), 1fr))", gap: 12, marginTop: 12 }}>
        <label className="stack">
          <span className="small muted">{L("הטקסט", "Text")}</span>
          <textarea
            dir="auto"
            rows={8}
            value={text}
            maxLength={max}
            placeholder={L("כתבו או הדביקו טקסט…", "Type or paste text…")}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) void translate();
            }}
            style={{ width: "100%", resize: "vertical" }}
          />
          <span className="small muted">{text.length.toLocaleString()} / {max.toLocaleString()}</span>
        </label>
        <div className="stack">
          <span className="small muted">{L("התרגום", "Translation")}</span>
          <textarea dir={out?.to === "he" ? "rtl" : "ltr"} rows={8} readOnly value={out?.text ?? ""} aria-label={L("התרגום", "Translation")} style={{ width: "100%", resize: "vertical" }} />
          {out && (
            <div className="row wrap" style={{ gap: 8, alignItems: "center" }}>
              <button type="button" className="small" onClick={copy}>{L("העתקה", "Copy")}</button>
              <button type="button" className="small" onClick={swap}>⇄ {L("להחליף כיוון", "Swap")}</button>
              {out.via !== "none" && <span className="muted small">{L("תורגם עם", "Translated with")} {viaText(out.via)}</span>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

import { useState } from "react";
import { getLocale } from "./i18n";
import { toast } from "./library";

const L = (he: string, en: string) => (getLocale() === "he" ? he : en);

/**
 * The ✨ AI bubble over a script (code or nodes, wherever the user is): a
 * request in words changes the script; "Fix the errors" sends the compiler's
 * errors; the change can be undone in one click, and nothing is saved until
 * the user saves.
 */
export function CodeAiBubble(p: { ask: (request: string, fix: boolean) => Promise<string>; errors: number; canUndo: boolean; onUndo: () => void; placeholder: string }) {
  const [open, setOpen] = useState(false);
  const [request, setRequest] = useState("");
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<Array<{ who: "me" | "ai"; text: string }>>([]);
  const run = async (fix: boolean) => {
    const text = fix ? L("תקן את שגיאות הקומפילציה", "Fix the compile errors") : request.trim();
    if (!text || busy) return;
    setBusy(true);
    setLog((l) => [...l, { who: "me", text }]);
    setRequest("");
    try {
      const note = await p.ask(fix ? "" : text, fix);
      setLog((l) => [...l, { who: "ai", text: note || L("הסקריפט עודכן. בדקו ושמרו.", "The script was changed. Check it, then save.") }]);
    } catch (e) {
      toast((e as Error).message);
      setLog((l) => [...l, { who: "ai", text: (e as Error).message }]);
    } finally {
      setBusy(false);
    }
  };
  if (!open) return <button type="button" className="ue-ai-fab primary" onClick={() => setOpen(true)} aria-label={L("עריכה עם AI", "Edit with AI")} title={L("עריכה עם AI", "Edit with AI")}>✨</button>;
  return (
    <div className="ue-bubble code-ai" role="dialog" aria-label={L("עריכה עם AI", "Edit with AI")}>
      <div className="row ue-bubble-head">
        <strong className="grow">✨ {L("עריכה עם AI", "Edit with AI")}</strong>
        {p.canUndo && <button type="button" className="small" onClick={p.onUndo} title={L("מחזיר את הסקריפט למה שהיה לפני השינוי האחרון של ה-AI", "Puts back the script as it was before the AI's last change")}>↶ {L("בטל שינוי", "Undo")}</button>}
        <button type="button" className="small" onClick={() => setOpen(false)} aria-label={L("סגור", "Close")}>✕</button>
      </div>
      <div className="ue-bubble-log" aria-live="polite">
        {!log.length && <p className="muted small">{L("כתבו מה לשנות. השינוי מופיע בסקריפט, ונשמר רק כשתלחצו שמור.", "Say what to change. It shows in the script and is saved only when you save.")}</p>}
        {log.map((m, i) => <div key={i} className={`ue-msg ${m.who}`} dir="auto">{m.text}</div>)}
        {busy && <div className="ue-msg ai muted">{L("המודל עובד…", "Working…")}</div>}
      </div>
      {p.errors > 0 && <button type="button" disabled={busy} onClick={() => void run(true)}>🩹 {L(`תקן ${p.errors} שגיאות`, `Fix ${p.errors} errors`)}</button>}
      <form className="row ue-ask" onSubmit={(e) => { e.preventDefault(); void run(false); }}>
        <input className="grow" dir="auto" autoFocus value={request} onChange={(e) => setRequest(e.target.value)} placeholder={p.placeholder} />
        <button type="submit" className="primary" disabled={busy || !request.trim()} aria-label={L("שנה", "Change")}>{busy ? "…" : "↑"}</button>
      </form>
    </div>
  );
}

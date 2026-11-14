import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "./api";
import { getLocale } from "./i18n";
import { toast } from "./library";

const L = (he: string, en: string) => (getLocale() === "he" ? he : en);

interface Report { version: string; system: string; faults: string[]; github: string; canSend: boolean }

/**
 * "Report a problem": shows exactly what will be sent (the version, the system and KesherAI's faults, already cleaned
 * of keys, tokens and personal paths), lets the person remove lines and say what happened, then sends it to the
 * project with no account needed. GitHub stays as another way.
 *
 * @param props.chat - Only this chat's faults.
 */
export function ReportDialog({ chat, onClose }: { chat?: string; onClose: () => void }) {
  const [r, setR] = useState<Report | null>(null);
  const [keep, setKeep] = useState<Set<string>>(new Set());
  const [what, setWhat] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void api<Report>(`/api/faults/report${chat ? `?chat=${encodeURIComponent(chat)}` : ""}`).then((x) => {
      setR(x);
      setKeep(new Set(x.faults));
    }, (e: Error) => toast(e.message));
  }, [chat]);
  const send = async () => {
    setBusy(true);
    try {
      await api("/api/faults/send", { method: "POST", body: { ...(chat ? { chat } : {}), what, faults: [...keep] } });
      toast(L("הדיווח נשלח. תודה!", "Report sent. Thank you!"));
      onClose();
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return createPortal(
    <div className="dialog-backdrop on-top" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog card stack report-dialog" role="dialog" aria-modal="true" aria-label={L("דיווח על תקלה", "Report a problem")} onKeyDown={(e) => e.key === "Escape" && onClose()}>
        <strong>{L("דיווח על תקלה למפתחים", "Report a problem to the developers")}</strong>
        {!r ? (
          <p className="muted">…</p>
        ) : (
          <>
            <label className="stack small">
              {L("מה קרה? (במילים שלכם, לא חובה)", "What happened? (in your words, optional)")}
              <textarea rows={3} dir="auto" value={what} onChange={(e) => setWhat(e.target.value)} />
            </label>
            <div className="stack small">
              <span>{L("זה מה שיישלח. סיסמאות, מפתחות ונתיבים אישיים כבר הוסרו. אפשר להוריד שורות:", "This is what goes. Passwords, keys and personal paths are already removed. Untick lines to leave them out:")}</span>
              <code dir="ltr" className="small">{r.version} · {r.system}</code>
              <ul className="report-lines">
                {r.faults.map((f) => (
                  <li key={f}>
                    <label className="check small">
                      <input type="checkbox" checked={keep.has(f)} onChange={(e) => setKeep((k) => { const n = new Set(k); if (e.target.checked) n.add(f); else n.delete(f); return n; })} />
                      <span dir="ltr">{f}</span>
                    </label>
                  </li>
                ))}
                {r.faults.length === 0 && <li className="muted small">{L("אין תקלות ביומן.", "No faults in the log.")}</li>}
              </ul>
            </div>
            <div className="row wrap">
              {r.canSend && <button type="button" className="primary" disabled={busy || (!what.trim() && keep.size === 0)} onClick={() => void send()}>{busy ? L("שולח…", "Sending…") : L("שלח (בלי חשבון)", "Send (no account needed)")}</button>}
              <a className="button" href={r.github} target="_blank" rel="noopener noreferrer">{L("או ב-GitHub", "Or on GitHub")}</a>
              <button type="button" onClick={onClose}>{L("ביטול", "Cancel")}</button>
            </div>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}

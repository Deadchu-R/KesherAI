import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "./api";
import { getLocale } from "./i18n";
import { toast } from "./library";

const L = (he: string, en: string) => (getLocale() === "he" ? he : en);
const GB = 1024 ** 3;
const size = (b: number) => (b >= GB ? `${Math.round((b / GB) * 10) / 10} GB` : `${Math.max(1, Math.round(b / 1024 ** 2))} MB`);

interface Action { id: string; kind: "unload" | "self-work" | "model"; name: string; bytes?: number; safe: boolean; note?: "changes" | "loaded-busy" | "unused" | "memory"; days?: number }

function label(a: Action): { title: string; detail: string } {
  if (a.kind === "unload")
    return {
      title: L("לפרוק את המודל מהזיכרון", "Unload the model from memory"),
      detail: a.note === "loaded-busy" ? L(`⁦${a.name}⁩ · צ'אט עובד עכשיו, עדיף לחכות`, `${a.name} · a chat is working now, better to wait`) : L(`⁦${a.name}⁩ · משחרר זיכרון. הצ'אט הבא יטען אותו שוב`, `${a.name} · frees memory; the next chat loads it again`),
    };
  if (a.kind === "self-work")
    return {
      title: L(`עותק ישן של עבודה עצמית (⁦${a.name}⁩)`, `An old self-work copy (${a.name})`),
      detail: a.note === "changes" ? L("יש בו שינויים שלא נשמרו ב-commit: הם יימחקו", "It has changes not saved in a commit: they would be lost") : L("הענף והעבודה נשארים, רק תיקיית העותק נמחקת", "The branch and its work stay; only the copy's folder goes"),
    };
  return { title: L(`מודל שלא היה בשימוש ⁦${a.days}⁩ ימים`, `A model not used for ${a.days} days`), detail: L(`⁦${a.name}⁩ · נמחק מהמחשב (אפשר להוריד שוב)`, `${a.name} · deleted from the computer (can be downloaded again)`) };
}

/**
 * PC Health's "Fix it for me": what KesherAI can safely do itself, with what each frees. Sure-safe ones are ticked;
 * ones that lose something are not. Nothing happens until the person presses the button.
 */
export function FixDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [list, setList] = useState<Action[] | null>(null);
  const [pick, setPick] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void api<{ actions: Action[] }>("/api/pc-health/fixes").then((r) => {
      setList(r.actions);
      setPick(new Set(r.actions.filter((a) => a.safe).map((a) => a.id)));
    }, (e: Error) => toast(e.message));
  }, []);
  const chosen = (list ?? []).filter((a) => pick.has(a.id));
  const freed = chosen.reduce((n, a) => n + (a.bytes ?? 0), 0);
  const deletes = chosen.some((a) => a.kind === "model" || a.note === "changes");
  const run = async () => {
    if (deletes && !window.confirm(L("חלק מהפריטים שבחרתם יימחקו לגמרי. להמשיך?", "Some chosen items will be deleted for good. Go ahead?"))) return;
    setBusy(true);
    try {
      const r = await api<{ done: string[]; failed: Array<{ id: string; error: string }>; freed: number }>("/api/pc-health/fix", { method: "POST", body: { ids: [...pick] } });
      toast(r.failed.length ? L(`בוצעו ${r.done.length}, נכשלו ${r.failed.length}: ${r.failed[0]!.error}`, `Done ${r.done.length}, failed ${r.failed.length}: ${r.failed[0]!.error}`) : L(`בוצע. התפנו ⁦${size(r.freed)}⁩`, `Done. ${size(r.freed)} freed`));
      onDone();
      onClose();
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return createPortal(
    <div className="dialog-backdrop on-top" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog card stack fix-dialog" role="dialog" aria-modal="true" aria-label={L("תקן לי", "Fix it for me")} onKeyDown={(e) => e.key === "Escape" && onClose()}>
        <strong>{L("🛠 תקן לי", "🛠 Fix it for me")}</strong>
        <p className="muted small">{L("מה ש-KesherAI יכול לעשות בעצמו, רק בדברים שלו. המסומנים בטוחים לגמרי; השאר רק אם תסמנו.", "What KesherAI can do itself, only with its own things. The ticked ones are fully safe; the rest only if you tick them.")}</p>
        {!list ? (
          <p className="muted">…</p>
        ) : list.length === 0 ? (
          <p className="muted">{L("אין כרגע מה לתקן. הכל נקי.", "Nothing to fix right now. All clean.")}</p>
        ) : (
          <ul className="report-lines">
            {list.map((a) => {
              const l = label(a);
              return (
                <li key={a.id}>
                  <label className="check">
                    <input type="checkbox" checked={pick.has(a.id)} onChange={(e) => setPick((p) => { const n = new Set(p); if (e.target.checked) n.add(a.id); else n.delete(a.id); return n; })} />
                    <span className="stack grow">
                      <span dir="auto">{l.title}{a.bytes ? <span className="muted"> · <span dir="ltr">{size(a.bytes)}</span></span> : null}</span>
                      <span className={`small ${a.note === "changes" ? "danger" : "muted"}`} dir="auto">{l.detail}</span>
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        )}
        <div className="row wrap">
          {!!list?.length && <button type="button" className="primary" disabled={busy || pick.size === 0} onClick={() => void run()}>{busy ? L("עושה…", "Doing it…") : freed ? L(`בצע (מפנה ⁦${size(freed)}⁩)`, `Do it (frees ${size(freed)})`) : L("בצע", "Do it")}</button>}
          <button type="button" onClick={onClose}>{L("סגור", "Close")}</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

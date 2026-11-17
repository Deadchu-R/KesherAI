import { useState } from "react";
import { api, withToken } from "./api";
import { openArtifact } from "./ArtifactPanel";
import { Diff } from "./ChatCards";
import { createPortal } from "react-dom";
import { getLocale, he$ } from "./i18n";
import { toast } from "./library";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);

/** A receipt as the agent writes it after a run that changed files. */
export interface ReceiptEvent {
  run: string;
  files: Array<{ path: string; kind: "new" | "changed" | "deleted"; added: number; removed: number }>;
}

/**
 * The receipt after an agent run that changed files (board t42; as Cursor's "Review changes", Copilot's Keep/Undo):
 * the files with the lines added and removed, and "Undo all" for the whole run. A file changed since the run is named
 * and changed back only after a yes.
 */
export function RunReceipt({ convId, ev, busy, undoneFiles }: { convId: string; ev: ReceiptEvent; busy: boolean; undoneFiles?: Set<string> }) {
  const undone = !!undoneFiles && ev.files.every((f) => undoneFiles.has(f.path));
  const [working, setWorking] = useState(false);
  const [review, setReview] = useState<Array<{ path: string; diff: string }> | null>(null);
  const openReview = () => void api<{ files: Array<{ path: string; diff: string }> }>(`/api/conversations/${convId}/runs/${encodeURIComponent(ev.run)}/diff`).then((r) => setReview(r.files), (e: Error) => toast(e.message));
  const [open, setOpen] = useState(ev.files.length <= 5);
  const added = ev.files.reduce((n, f) => n + f.added, 0);
  const removed = ev.files.reduce((n, f) => n + f.removed, 0);
  // Every file of the run, or one (its own ↶, like Cursor's per-file reject).
  const undo = async (path?: string) => {
    const left = ev.files.filter((f) => !undoneFiles?.has(f.path)).length;
    if (!confirm(path ? L(`להחזיר את ${path} למה שהיה לפני הריצה הזאת?`, `Put ${path} back as it was before this run?`) : L(`להחזיר ${left} קבצים למה שהיו לפני הריצה הזאת?`, `Put ${left} files back as they were before this run?`))) return;
    setWorking(true);
    try {
      const url = `/api/conversations/${convId}/runs/${encodeURIComponent(ev.run)}/undo`;
      let r = await api<{ files: string[]; conflicts: string[] }>(url, { method: "POST", body: path ? { path } : {} });
      if (r.conflicts.length) {
        const names = r.conflicts.join("\n");
        if (!confirm(L(`הקבצים האלה השתנו אחרי הריצה (על ידך או ריצה אחרת):\n${names}\n\nלהחזיר גם אותם? השינויים המאוחרים בהם יאבדו.`, `These files changed after the run (by you or another run):\n${names}\n\nPut them back too? The later changes in them are lost.`))) return;
        r = await api<{ files: string[]; conflicts: string[] }>(url, { method: "POST", body: path ? { force: true, path } : { force: true } });
      }
      toast(L(`הוחזרו ${r.files.length} קבצים.`, `Put back ${r.files.length} files.`));
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setWorking(false);
    }
  };
  const mark = { new: L("חדש", "new"), changed: "", deleted: L("נמחק", "deleted") };
  // A page the run wrote opens live beside the chat, like a page written in the answer (ArtifactPanel).
  const pages = ev.files.filter((f) => f.kind !== "deleted" && /\.(html?|svg)$/i.test(f.path));
  const openLive = async (path: string) => {
    const r = await fetch(withToken(`/api/conversations/${encodeURIComponent(convId)}/files/download?path=${encodeURIComponent(path)}`)).catch(() => undefined);
    if (!r?.ok) return toast(L("לא הצלחתי לפתוח את הקובץ.", "Could not open the file."));
    openArtifact(await r.text());
  };
  return (
    <div className={`receipt card${undone ? " undone" : ""}`}>
      <div className="row receipt-head">
        <button type="button" className="link-btn grow receipt-sum" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? "▾" : "▸"} {L(`${ev.files.length} קבצים השתנו`, `${ev.files.length} ${ev.files.length === 1 ? "file" : "files"} changed`)}
          <span className="receipt-plus" dir="ltr">+{added}</span>
          <span className="receipt-minus" dir="ltr">−{removed}</span>
        </button>
        {pages.length === 1 && <button type="button" className="primary small" onClick={() => void openLive(pages[0]!.path)}>{L("פתח חי ▸", "Open live ▸")}</button>}
        {!undone && <button type="button" className="small" onClick={openReview} title={L("כל השינויים של הריצה במקום אחד", "Every change of this run in one place")}>{L("סקירה", "Review")}</button>}
        {undone ? (
          <span className="muted small">{L("בוטל", "Undone")}</span>
        ) : (
          <button type="button" className="small" disabled={busy || working} onClick={() => void undo()} title={L("מחזיר את כל הקבצים של הריצה הזאת למה שהיו לפניה", "Puts every file of this run back as it was before it")}>
            ↶ {L("בטל הכל", "Undo all")}
          </button>
        )}
      </div>
      {open && (
        <ul className="receipt-files">
          {ev.files.map((f) => (
            <li key={f.path} className="row">
              <span className="mono grow receipt-path" dir="ltr" title={f.path}>{f.path}</span>
              {mark[f.kind] && <span className={`pill small ${f.kind}`}>{mark[f.kind]}</span>}
              <span className="receipt-plus small" dir="ltr">+{f.added}</span>
              <span className="receipt-minus small" dir="ltr">−{f.removed}</span>
              {pages.includes(f) && pages.length > 1 && <button type="button" className="ghost small" onClick={() => void openLive(f.path)}>{L("פתח חי", "Open live")}</button>}
              {undoneFiles?.has(f.path) ? <span className="muted small">{L("הוחזר", "Put back")}</span> : !undone && ev.files.length > 1 && <button type="button" className="ghost small" disabled={busy || working} title={L("להחזיר רק את הקובץ הזה", "Put back only this file")} onClick={() => void undo(f.path)}>↶</button>}
            </li>
          ))}
        </ul>
      )}
      {review && createPortal(
        <div className="dialog-backdrop" role="presentation" onClick={() => setReview(null)}>
          <div className="dialog card run-review" role="dialog" aria-modal="true" aria-label={L("סקירת השינויים", "Review the changes")} onClick={(e) => e.stopPropagation()}>
            <header className="row">
              <strong className="grow">{L(`סקירה: ${review.length} קבצים`, `Review: ${review.length} files`)} <span className="receipt-plus small" dir="ltr">+{added}</span> <span className="receipt-minus small" dir="ltr">−{removed}</span></strong>
              <button type="button" className="ghost" onClick={() => setReview(null)} aria-label={L("סגירה", "Close")}>✕</button>
            </header>
            <div className="run-review-body">
              {review.map((f) => (
                <section key={f.path} className="run-review-file">
                  <div className="row"><span className="mono grow" dir="ltr">{f.path}</span>
                    {undoneFiles?.has(f.path) ? <span className="muted small">{L("הוחזר", "Put back")}</span> : <button type="button" className="ghost small" disabled={busy || working} onClick={() => void undo(f.path).then(openReview)}>↶ {L("החזר", "Put back")}</button>}
                  </div>
                  <Diff diff={f.diff} />
                </section>
              ))}
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}

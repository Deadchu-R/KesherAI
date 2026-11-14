import { useState } from "react";
import { api } from "./api";
import { getLocale } from "./i18n";
import { toast } from "./library";

const L = (he: string, en: string) => (getLocale() === "he" ? he : en);

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
export function RunReceipt({ convId, ev, busy, undone }: { convId: string; ev: ReceiptEvent; busy: boolean; undone: boolean }) {
  const [working, setWorking] = useState(false);
  const [open, setOpen] = useState(ev.files.length <= 5);
  const added = ev.files.reduce((n, f) => n + f.added, 0);
  const removed = ev.files.reduce((n, f) => n + f.removed, 0);
  const undo = async () => {
    if (!confirm(L(`להחזיר ${ev.files.length} קבצים למה שהיו לפני הריצה הזאת?`, `Put ${ev.files.length} files back as they were before this run?`))) return;
    setWorking(true);
    try {
      const url = `/api/conversations/${convId}/runs/${encodeURIComponent(ev.run)}/undo`;
      let r = await api<{ files: string[]; conflicts: string[] }>(url, { method: "POST", body: {} });
      if (r.conflicts.length) {
        const names = r.conflicts.join("\n");
        if (!confirm(L(`הקבצים האלה השתנו אחרי הריצה (על ידך או ריצה אחרת):\n${names}\n\nלהחזיר גם אותם? השינויים המאוחרים בהם יאבדו.`, `These files changed after the run (by you or another run):\n${names}\n\nPut them back too? The later changes in them are lost.`))) return;
        r = await api<{ files: string[]; conflicts: string[] }>(url, { method: "POST", body: { force: true } });
      }
      toast(L(`הוחזרו ${r.files.length} קבצים.`, `Put back ${r.files.length} files.`));
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setWorking(false);
    }
  };
  const mark = { new: L("חדש", "new"), changed: "", deleted: L("נמחק", "deleted") };
  return (
    <div className={`receipt card${undone ? " undone" : ""}`}>
      <div className="row receipt-head">
        <button type="button" className="link-btn grow receipt-sum" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? "▾" : "▸"} {L(`${ev.files.length} קבצים השתנו`, `${ev.files.length} ${ev.files.length === 1 ? "file" : "files"} changed`)}
          <span className="receipt-plus" dir="ltr">+{added}</span>
          <span className="receipt-minus" dir="ltr">−{removed}</span>
        </button>
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
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

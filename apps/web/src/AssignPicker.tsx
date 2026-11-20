import { useState } from "react";
import { ASSIGN_CHOICES, assignQuestion, type AssignResult, type AssignTo } from "@kesher/shared";
import { api } from "./api";
import { getLocale, he$ } from "./i18n";
import { toast } from "./library";

/**
 * "Who does it" (Roee, 2026-11-20; boards InboxAssign, PhoneInboxAssign): a button that opens the list of executors
 * (Claude, Antigravity, the local model, a chat agent role) for an inbox task or a work-list item. Choosing one sends
 * it through the server (task-assign.ts), so it works the same from the phone in remote. A running or finished task
 * asks first; nothing is stopped or run again without the user's yes.
 */

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);

/**
 * @param p.id - The inbox task id, or the work-list item id (`w-…`).
 * @param p.current - Who has it now (marked in the list).
 * @param p.label - The button's text (default "Who does it").
 * @param p.onDone - Called after a change (to load the list again).
 */
export function AssignPicker({ id, current, label, onDone }: { id: string; current?: AssignTo; label?: string; onDone?: () => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const send = async (to: AssignTo, confirm = false): Promise<void> => {
    setBusy(true);
    try {
      const r = await api<AssignResult>(`/api/task-inbox/assign/${encodeURIComponent(id)}`, { method: "POST", body: { to, confirm } });
      if (r.ask && !confirm) {
        const q = assignQuestion(r.ask, to);
        if (window.confirm(L(q.he, q.en))) return await send(to, true);
        return;
      }
      toast(r.text);
      if (r.ok) {
        setOpen(false);
        onDone?.();
      }
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className="assign">
      <button type="button" aria-expanded={open} aria-haspopup="true" disabled={busy} onClick={() => setOpen((o) => !o)}>
        👤 {label ?? L("מי עושה", "Who does it")} ▾
      </button>
      {open && (
        <span className="assign-list" role="group" aria-label={L("למי לתת את המשימה", "Who to give the task to")}>
          {ASSIGN_CHOICES.map((c) => (
            <button type="button" key={c.to} className={`assign-opt${c.to === current ? " on" : ""}`} aria-pressed={c.to === current} disabled={busy} onClick={() => void send(c.to)}>
              <span aria-hidden>{c.icon}</span>
              <span className="assign-t">
                <b>{L(c.he, c.en)}</b>
                <span className="small muted">{c.to === current ? L("אצלו עכשיו", "Has it now") : L(c.noteHe, c.noteEn)}</span>
              </span>
            </button>
          ))}
        </span>
      )}
    </span>
  );
}

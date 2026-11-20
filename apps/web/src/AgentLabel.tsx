import { useState } from "react";
import { AGENT_LABEL_LIMITS, type AgentLabel, type LabelWords } from "@kesher/shared";
import { getLocale, he$ } from "./i18n";
import { toast } from "./library";

/**
 * Agent names and notes in the app (docs/RESEARCH_LOG.md, "Agent names and notes", 2026-11-20; boards HelperCardLabel,
 * PhoneHelperLabel, InboxTaskLabel): the owner's own name for an agent (shown instead of its task, with the task as a
 * subtitle), the owner's note about it, and the agent's own "doing now" line, kept apart from the note. The editor
 * saves through the server, so it works the same from the phone in remote; the PC keeps the label and sends it to
 * the hub page and Google Drive.
 */

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);

/** Words in the screen's language. */
export const words = (w: LabelWords | undefined): string => (w ? L(w.he, w.en) : "");

/**
 * The lines under an agent's header: its original task (when a name replaces it), "doing now", and the owner's note.
 * Everything wraps; nothing is cut.
 *
 * @param p.title - The run's task.
 * @param p.name - The owner's name, if any.
 * @param p.note - The owner's note, if any.
 * @param p.doing - The agent's own "doing now" line, if it is going.
 */
export function AgentLabelLines({ title, name, note, doing }: { title: string; name?: string; note?: string; doing?: LabelWords }) {
  return (
    <>
      {name && name !== title && <div className="alab-sub small muted" dir="auto">{L("משימה: ", "Task: ")}{title}</div>}
      {doing && (
        <div className="alab-doing small" dir="auto">
          <span className="alab-k">{L("עכשיו", "Now")}</span> {words(doing)}
        </div>
      )}
      {note && (
        <div className="alab-note small" dir="auto">
          <span aria-hidden>📝 </span>
          <span className="sr-only">{L("ההערה שלך: ", "Your note: ")}</span>
          {note}
        </div>
      )}
    </>
  );
}

/**
 * The edit form for an agent's name and note: Save, Clear (both), Cancel. The note is the owner's own and is never
 * sent to the agent's model.
 *
 * @param p.title - The run's task (the name's placeholder).
 * @param p.label - The name and note now.
 * @param p.save - Saves a label (an empty field clears it); rejects with the server's error.
 * @param p.onClose - Closes the form.
 */
export function AgentLabelEditor({ title, label, save, onClose }: { title: string; label: AgentLabel; save: (l: AgentLabel) => Promise<unknown>; onClose: () => void }) {
  const [name, setName] = useState(label.name ?? "");
  const [note, setNote] = useState(label.note ?? "");
  const [busy, setBusy] = useState(false);
  const submit = (l: AgentLabel) => {
    setBusy(true);
    save(l).then(
      () => onClose(),
      (e: Error) => {
        setBusy(false);
        toast(e.message || L("לא נשמר", "Not saved"));
      },
    );
  };
  return (
    <form
      className="alab-form"
      onSubmit={(e) => {
        e.preventDefault();
        submit({ name, note });
      }}
    >
      <label className="small">
        {L("שם לסוכן", "Agent name")}
        <input value={name} maxLength={AGENT_LABEL_LIMITS.nameChars} placeholder={title} dir="auto" onChange={(e) => setName(e.target.value)} autoFocus />
      </label>
      <label className="small">
        {L("הערה (רק בשבילך, לא נשלחת לסוכן)", "Note (just for you, not sent to the agent)")}
        <textarea value={note} rows={3} maxLength={AGENT_LABEL_LIMITS.noteChars} dir="auto" placeholder={L("למשל: בודק את הבאג של ההתחברות", "For example: checking the login bug")} onChange={(e) => setNote(e.target.value)} />
      </label>
      <div className="alab-acts">
        <button type="submit" className="primary" disabled={busy}>{L("שמור", "Save")}</button>
        <button type="button" onClick={onClose} disabled={busy}>{L("ביטול", "Cancel")}</button>
        <span className="grow" />
        {(label.name || label.note) && (
          <button type="button" className="link muted small" disabled={busy} onClick={() => submit({})}>{L("נקה שם והערה", "Clear name and note")}</button>
        )}
      </div>
    </form>
  );
}

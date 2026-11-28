/**
 * The card for the model's `schedule_task` call: what will be saved (name, the schedule in words and the next run in
 * local time, the instructions) with Save / Edit / Cancel. Nothing is saved before Save. It answers the same approval
 * request as every approval card (Save = allow, Cancel = deny), so it works on the computer and over remote on the phone.
 * Edit opens the fields; "Send changes" denies with the new values, and the model asks again with them.
 */
import { useState } from "react";
import { api } from "../api";
import { getLocale, he$ } from "../i18n";
import { parseSchedulePreview, scheduleEditNote, type ScheduleConfirm } from "../schedule-confirm";
import { describeWhen } from "./ScheduledList";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);

/** @returns A time as "Mon, 30 Nov, 08:30" in the interface language and this computer's zone. */
function nextText(ms: number): string {
  return new Date(ms).toLocaleString(getLocale() === "he" ? "he-IL" : undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

/**
 * @param props.convId - The chat.
 * @param props.requestId - The approval request to answer.
 * @param props.preview - The request's preview (see `parseSchedulePreview`).
 * @returns The card, or null when the preview is not a schedule one.
 */
export function ScheduleConfirmCard({ convId, requestId, preview }: { convId: string; requestId: string; preview: string }) {
  const c = parseSchedulePreview(preview);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<ScheduleConfirm | undefined>(c);
  if (!c || !draft) return null;
  const answer = async (decision: "allow" | "deny", feedback?: string) => {
    setBusy(true);
    await api(`/api/conversations/${convId}/approvals/${requestId}`, { method: "POST", body: { decision, ...(feedback ? { feedback } : {}) } }).catch(() => undefined);
    setBusy(false);
  };
  return (
    <div className="card approval schedule-confirm" role="group" aria-label={L("לשמור משימה מתוזמנת", "Save a scheduled task")} data-guard="">
      <strong dir="auto">{L("לשמור משימה מתוזמנת?", "Save this scheduled task?")}</strong>
      {editing ? (
        <div className="stack">
          <label className="small">{L("שם", "Name")}<input value={draft.name} maxLength={80} dir="auto" onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></label>
          <label className="small">{L("מתי (למשל daily 08:30, weekdays 09:00, weekly mon 18:00, every 6 hours)", "When (e.g. daily 08:30, weekdays 09:00, weekly mon 18:00, every 6 hours)")}<input value={draft.when} dir="ltr" onChange={(e) => setDraft({ ...draft, when: e.target.value })} /></label>
          <label className="small">{L("מה לעשות בכל פעם", "What to do each time")}<textarea rows={4} value={draft.prompt} dir="auto" maxLength={2000} onChange={(e) => setDraft({ ...draft, prompt: e.target.value })} /></label>
          <label className="small row"><input type="checkbox" checked={draft.newChat} onChange={(e) => setDraft({ ...draft, newChat: e.target.checked })} />{L("צ'אט חדש בכל פעם", "A new chat each time")}</label>
        </div>
      ) : (
        <dl className="schedule-facts">
          <dt>{L("שם", "Name")}</dt>
          <dd dir="auto">{c.name}</dd>
          <dt>{L("מתי", "Schedule")}</dt>
          <dd dir="auto">{describeWhen(c.when)}{c.newChat ? ` · ${L("צ'אט חדש בכל פעם", "new chat each time")}` : ""}</dd>
          <dt>{L("ריצה הבאה", "Next run")}</dt>
          <dd dir="auto">{nextText(c.next)}</dd>
          <dt>{L("ההוראות", "Instructions")}</dt>
          <dd><pre className="code" dir="auto">{c.prompt}</pre></dd>
        </dl>
      )}
      <div className="row">
        {editing ? (
          <>
            <button type="button" className="primary" disabled={busy || !draft.name.trim() || !draft.prompt.trim()} onClick={() => void answer("deny", scheduleEditNote(draft))}>{L("שלח שינויים", "Send changes")}</button>
            <button type="button" disabled={busy} onClick={() => (setDraft(c), setEditing(false))}>{L("חזרה", "Back")}</button>
          </>
        ) : (
          <>
            <button type="button" className="primary" disabled={busy} onClick={() => void answer("allow")}>{L("שמירה", "Save")}</button>
            <button type="button" disabled={busy} onClick={() => setEditing(true)}>{L("עריכה", "Edit")}</button>
            <button type="button" disabled={busy} onClick={() => void answer("deny", "The user cancelled it. Do not schedule it.")}>{L("ביטול", "Cancel")}</button>
          </>
        )}
      </div>
    </div>
  );
}

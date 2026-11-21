import { useState } from "react";
import type { QueueMode } from "@kesher/shared";
import { api } from "../api";
import { getLocale, he$, t } from "../i18n";
import { toast } from "../library";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);

/**
 * Messages typed while the chat works, as chips under the message box (chat-queue.ts; Jan 0.8, Cursor): each can be
 * edited (✎), sent now (it joins the running turn at its next step) or removed (✕). The header switches what a new
 * message does while the chat works: waits for the answer (Queue) or steers the running turn (Steer). Everything goes
 * through the server, so the phone (remote) sees and changes the same queue.
 */

const MODE_KEY = "kesher.queueMode";

/** @returns What a message typed while the chat works does (kept on this device). */
export function queueMode(): QueueMode {
  try {
    return localStorage.getItem(MODE_KEY) === "steer" ? "steer" : "queue";
  } catch {
    return "queue";
  }
}

/**
 * The queue's chips and the Queue / Steer switch.
 *
 * @param props.convId - The conversation.
 * @param props.queued - The waiting messages (from the session info).
 * @param props.paused - Whether the queue waits after a Stop.
 * @param props.busy - Whether the chat works now (the switch shows only then).
 * @param props.typing - Whether there is text in the box (the switch shows before the first queued message).
 * @param props.mode - The current mode; `onMode` changes it.
 */
export function QueueChips(p: { convId: string; queued: Array<{ id: string; text: string; steer?: boolean }>; paused?: boolean; busy: boolean; typing: boolean; mode: QueueMode; onMode: (m: QueueMode) => void }) {
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  if (!p.queued.length && !(p.busy && p.typing)) return null;
  const base = `/api/conversations/${p.convId}/queue`;
  const fail = (e: Error) => toast(e.message);
  const setMode = (m: QueueMode) => {
    try {
      localStorage.setItem(MODE_KEY, m);
    } catch {
      /* private mode: kept for this page only */
    }
    p.onMode(m);
  };
  const save = (id: string) => {
    if (!draft.trim()) return;
    setEditing(null);
    void api(`${base}/${id}`, { method: "PATCH", body: { text: draft } }).catch(fail);
  };
  return (
    <div className="queue" aria-label={t("queueTitle")}>
      <div className="queue-head small">
        <span>{p.paused ? t("queuePaused") : p.queued.length ? t("queueWaiting", { n: p.queued.length }) : L("הודעה בזמן שהצ'אט עובד:", "A message while the chat works:")}</span>
        {p.paused && <button type="button" className="link-btn" onClick={() => void api(`${base}/resume`, { method: "POST" }).catch(fail)}>{t("queueResume")}</button>}
        {p.busy && (
          <span className="segmented queue-mode" role="group" aria-label={L("מה הודעה חדשה עושה בזמן העבודה", "What a new message does while it works")}>
            <button type="button" className={p.mode === "queue" ? "on" : ""} aria-pressed={p.mode === "queue"} title={L("מחכה לסוף התשובה ונשלחת אחריה", "Waits for the answer, then goes")} onClick={() => setMode("queue")}>{L("בתור", "Queue")}</button>
            <button type="button" className={p.mode === "steer" ? "on" : ""} aria-pressed={p.mode === "steer"} title={L("נכנסת לתשובה שרצה, בצעד הבא של המודל", "Joins the running answer at the model's next step")} onClick={() => setMode("steer")}>{L("היגוי", "Steer")}</button>
          </span>
        )}
      </div>
      {p.queued.length > 0 && (
        <ol>
          {p.queued.map((q, i) => (
            <li key={q.id} className={q.steer ? "steer" : undefined}>
              <span className="queue-n" aria-hidden>{q.steer ? "↪" : i + 1}</span>
              {editing === q.id ? (
                <form className="queue-edit" onSubmit={(e) => { e.preventDefault(); save(q.id); }}>
                  <textarea dir="auto" autoFocus rows={Math.min(6, draft.split("\n").length + 1)} value={draft} aria-label={L("עריכת ההודעה שבתור", "Edit the queued message")} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); save(q.id); }
                    if (e.key === "Escape") setEditing(null);
                  }} />
                  <span className="row">
                    <button type="button" onClick={() => setEditing(null)}>{t("cancel")}</button>
                    <button type="submit" className="primary" disabled={!draft.trim()}>{L("שמירה", "Save")}</button>
                  </span>
                </form>
              ) : (
                <>
                  <span className="queue-text" dir="auto">
                    {q.steer && <span className="queue-tag">{L("ייכנס בצעד הבא", "goes in at the next step")}</span>}
                    {q.text}
                  </span>
                  <button type="button" className="queue-x" aria-label={L("עריכה", "Edit")} title={L("עריכה", "Edit")} onClick={() => { setEditing(q.id); setDraft(q.text); }}>✎</button>
                  {!q.steer && <button type="button" className="queue-x" aria-label={L("לשלוח עכשיו", "Send now")} title={p.busy ? L("לשלוח עכשיו: נכנסת לתשובה שרצה בצעד הבא", "Send now: joins the running answer at its next step") : L("לשלוח עכשיו", "Send now")} onClick={() => void api(`${base}/${q.id}/now`, { method: "POST" }).catch(fail)}>↑</button>}
                  <button type="button" className="queue-x" aria-label={t("queueRemove")} title={t("queueRemove")} onClick={() => void api(`${base}/${q.id}`, { method: "DELETE" }).catch(() => undefined)}>✕</button>
                </>
              )}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

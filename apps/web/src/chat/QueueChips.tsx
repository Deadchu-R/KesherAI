import { useEffect, useRef, useState } from "react";
import type { QueueMode, StopAfter } from "@kesher/shared";
import { api } from "../api";
import { getLocale, he$, t } from "../i18n";
import { toast } from "../library";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);

/**
 * Messages typed while the chat works, as chips under the message box (chat-queue.ts; Jan 0.8, Cursor): each can be
 * edited (✎), moved (↑ ↓, or dragged with a mouse), sent now ("Steer now": it joins the running turn at its next
 * step) or removed (✕). The header switches what a new message does while the chat works: waits for the answer
 * (Queue) or steers the running turn (Steer); Alt+Enter in the message box steers one message whatever the switch. Everything goes
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
 * The queue's chips, the Queue / Steer switch and, after Stop with messages waiting, the two Stop choices.
 *
 * @param props.convId - The conversation.
 * @param props.queued - The waiting messages (from the session info).
 * @param props.paused - Whether the queue waits after a Stop.
 * @param props.busy - Whether the chat works now (the switch shows only then).
 * @param props.typing - Whether there is text in the box (the switch shows before the first queued message).
 * @param props.mode - The current mode; `onMode` changes it.
 * @param props.canSteer - `false` when the running turn cannot be steered (an outside agent): no switch, no "Steer now".
 * @param props.asking - Stop was pressed with messages waiting: show "Stop and send next" / "Stop and clear queue".
 * @param props.onStop - Answers the Stop question (`undefined`: cancel, nothing stops).
 */
export function QueueChips(p: {
  convId: string;
  queued: Array<{ id: string; text: string; steer?: boolean }>;
  paused?: boolean;
  busy: boolean;
  typing: boolean;
  mode: QueueMode;
  onMode: (m: QueueMode) => void;
  canSteer?: boolean;
  asking?: boolean;
  onStop?: (after?: StopAfter) => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [dragId, setDragId] = useState<string | null>(null);
  const askRef = useRef<HTMLButtonElement>(null);
  // The Stop question takes the focus, so the keyboard answers it at once (Escape cancels).
  useEffect(() => {
    if (p.asking) askRef.current?.focus();
  }, [p.asking]);
  if (!p.queued.length && !(p.busy && p.typing)) return null;
  const base = `/api/conversations/${p.convId}/queue`;
  const fail = (e: Error) => toast(e.message);
  const steerable = p.busy && p.canSteer !== false;
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
  const move = (id: string, to: number) => void api(`${base}/${id}/move`, { method: "POST", body: { to } }).catch(fail);
  const last = p.queued.length - 1;
  return (
    <div className="queue" aria-label={t("queueTitle")}>
      <div className="queue-head small">
        <span>{p.paused ? t("queuePaused") : p.queued.length ? t("queueWaiting", { n: p.queued.length }) : L("הודעה בזמן שהצ'אט עובד:", "A message while the chat works:")}</span>
        {p.paused && <button type="button" className="link-btn" onClick={() => void api(`${base}/resume`, { method: "POST" }).catch(fail)}>{t("queueResume")}</button>}
        {steerable && (
          <span className="segmented queue-mode" role="group" aria-label={L("מה הודעה חדשה עושה בזמן העבודה", "What a new message does while it works")}>
            <button type="button" className={p.mode === "queue" ? "on" : ""} aria-pressed={p.mode === "queue"} title={L("מחכה לסוף התשובה ונשלחת אחריה (Alt+Enter: מכוון עכשיו)", "Waits for the answer, then goes (Alt+Enter: steer now)")} onClick={() => setMode("queue")}>{L("בתור", "Queue")}</button>
            <button type="button" className={p.mode === "steer" ? "on" : ""} aria-pressed={p.mode === "steer"} title={L("נכנסת לתשובה שרצה, בצעד הבא של המודל", "Joins the running answer at the model's next step")} onClick={() => setMode("steer")}>{L("היגוי", "Steer")}</button>
          </span>
        )}
        {p.busy && p.canSteer === false && <span className="queue-note">{L("את הסוכן הזה אי אפשר לכוון באמצע: ההודעות יישלחו אחרי התשובה.", "This agent can't be steered mid-answer: messages go after the answer.")}</span>}
      </div>
      {p.asking && p.onStop && (
        <div className="queue-stop" role="group" aria-label={L("מה לעשות עם התור כשעוצרים", "What to do with the queue on Stop")} onKeyDown={(e) => e.key === "Escape" && p.onStop?.(undefined)}>
          <button ref={askRef} type="button" className="primary" onClick={() => p.onStop?.("next")}>{L("לעצור ולשלוח את הבאה", "Stop and send next")}</button>
          <button type="button" onClick={() => p.onStop?.("clear")}>{L("לעצור ולנקות את התור", "Stop and clear queue")}</button>
          <button type="button" className="link-btn" onClick={() => p.onStop?.(undefined)}>{t("cancel")}</button>
        </div>
      )}
      {p.queued.length > 0 && (
        <ol>
          {p.queued.map((q, i) => (
            <li
              key={q.id}
              className={`${q.steer ? "steer" : ""}${dragId === q.id ? " dragging" : ""}`.trim() || undefined}
              draggable={editing !== q.id}
              onDragStart={(e) => { setDragId(q.id); e.dataTransfer.effectAllowed = "move"; }}
              onDragEnd={() => setDragId(null)}
              onDragOver={(e) => { if (dragId) e.preventDefault(); }}
              onDrop={(e) => { e.preventDefault(); if (dragId && dragId !== q.id) move(dragId, i); setDragId(null); }}
            >
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
                  <span className="queue-top">
                    <span className="queue-n" aria-hidden>{q.steer ? "↪" : i + 1}</span>
                    <span className="queue-text" dir="auto" title={q.text}>
                      {q.steer && <span className="queue-tag">{L("ייכנס בצעד הבא (או מיד אחרי התשובה)", "goes in at the next step (or right after the answer)")}</span>}
                      {q.text}
                    </span>
                  </span>
                  <span className="queue-actions">
                    {!q.steer && (
                      <button type="button" className="queue-now" title={steerable ? L("נכנסת לתשובה שרצה בצעד הבא של המודל", "Joins the running answer at the model's next step") : L("נשלחת ראשונה, מיד כשהתשובה נגמרת", "Goes first, as soon as the answer ends")} onClick={() => void api(`${base}/${q.id}/now`, { method: "POST" }).catch(fail)}>
                        {steerable ? L("↪ כוון עכשיו", "↪ Steer now") : p.busy ? L("הבאה בתור", "Send next") : L("לשלוח עכשיו", "Send now")}
                      </button>
                    )}
                    {/* Order: the buttons work by keyboard and on a phone; dragging is a shortcut with a mouse. */}
                    <button type="button" className="queue-x" disabled={i === 0} aria-label={L("להקדים", "Move earlier")} title={L("להקדים", "Move earlier")} onClick={() => move(q.id, i - 1)}>↑</button>
                    <button type="button" className="queue-x" disabled={i === last} aria-label={L("לדחות", "Move later")} title={L("לדחות", "Move later")} onClick={() => move(q.id, i + 1)}>↓</button>
                    <button type="button" className="queue-x" aria-label={L("עריכה", "Edit")} title={L("עריכה", "Edit")} onClick={() => { setEditing(q.id); setDraft(q.text); }}>✎</button>
                    <button type="button" className="queue-x" aria-label={t("queueRemove")} title={t("queueRemove")} onClick={() => void api(`${base}/${q.id}`, { method: "DELETE" }).catch(() => undefined)}>✕</button>
                  </span>
                </>
              )}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

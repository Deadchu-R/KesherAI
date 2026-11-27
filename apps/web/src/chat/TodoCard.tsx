import { useEffect, useState } from "react";
import { getLocale, he$ } from "../i18n";
import type { TodoView } from "./todo-view";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);

/**
 * The chat's live task list (as Claude's task list widget): the agent's steps for the current job, ✅ done, 🔄 now,
 * ⬜ next, at the end of the thread above the turn's status line. While steps are left it is open; when all are done it
 * folds to "✅ 7/7 steps" (a tap opens it again). The same card is the phone's (remote) view: it wraps on a 390 px
 * screen, and the step texts take their own direction (`dir="auto"`), so Hebrew and English steps both read right.
 *
 * @param props.view - The list (todoView).
 * @param props.busy - The agent works now: the step in progress pulses.
 */
export function TodoCard({ view, busy }: { view: TodoView; busy: boolean }) {
  const [open, setOpen] = useState(!view.finished);
  // Fold once the last step is done; open again when a new list (or a step put back) has work left.
  useEffect(() => {
    setOpen(!view.finished);
  }, [view.finished]);
  const count = <bdi dir="ltr">{view.done}/{view.total}</bdi>;
  return (
    <details className={`card todo-card${view.finished ? " finished" : ""}`} open={open} onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
      <summary className="row todo-head">
        <span aria-hidden="true">{view.finished ? "✅" : "📋"}</span>
        <strong className="grow">{view.finished ? <>{count} {L("שלבים הושלמו", "steps done")}</> : <>{L("משימות", "Tasks")} · {count}</>}</strong>
      </summary>
      <div className="steps-bar" role="progressbar" aria-label={L("התקדמות", "Progress")} aria-valuemin={0} aria-valuemax={view.total} aria-valuenow={view.done}>
        <span style={{ width: `${(view.done / view.total) * 100}%` }} />
      </div>
      <ol className="todo-list">
        {view.lines.map((l) => (
          <li key={l.id} className={`todo-item ${l.state}${l.state === "in_progress" && busy ? " live" : ""}`}>
            <span className="todo-mark" role="img" aria-label={l.state === "done" ? L("בוצע", "Done") : l.state === "in_progress" ? L("בעבודה", "In progress") : L("ממתין", "Waiting")}>{l.mark}</span>
            <span dir="auto">{l.text}</span>
          </li>
        ))}
      </ol>
    </details>
  );
}

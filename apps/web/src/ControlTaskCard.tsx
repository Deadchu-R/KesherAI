import { useState } from "react";
import { api } from "./api";
import { getLocale, he$ } from "./i18n";
import { parseApps, stepWordHe, type ControlTaskView } from "./control-live-view";

/**
 * The computer task in "What the agent is doing" (ControlLive.tsx): one goal that KesherAI carries out on the
 * computer by itself (packages/core/src/control-task.ts). Shows who works on what (the goal, the step, the model),
 * the question when it needs you with an answer box, Stop, the last steps with their small pictures, and at the end the
 * summary and the last screenshot. With no task running, a small form starts one ("Give the computer a task"). The
 * same on the computer, in remote and in the Android app; the server checks that the request comes from this
 * computer or a paired device.
 */

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);

const STATUS: Record<ControlTaskView["status"], () => string> = {
  running: () => L("עובד", "Working"),
  "needs-you": () => L("מחכה לך", "Needs you"),
  done: () => L("הושלם", "Done"),
  failed: () => L("לא הצליח", "Did not finish"),
  stopped: () => L("נעצר", "Stopped"),
};

/**
 * @param props.task - The task (null: none running or recent).
 * @param props.enabled - Computer control is on (the form says to turn it on otherwise).
 * @param props.onChange - Asks the live view to read again now.
 */
export function ControlTaskCard({ task, enabled, onChange }: { task: ControlTaskView | null | undefined; enabled: boolean; onChange: () => void }) {
  const [goal, setGoal] = useState("");
  const [apps, setApps] = useState("");
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const live = task && (task.status === "running" || task.status === "needs-you");
  const send = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
      onChange();
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy(false);
  };
  const start = () =>
    send(async () => {
      await api("/api/control/tasks", { method: "POST", body: { goal: goal.trim(), apps: parseApps(apps) } });
      setGoal("");
    });
  const reply = () =>
    send(async () => {
      await api(`/api/control/tasks/${task!.id}/answer`, { method: "POST", body: { text: answer.trim() } });
      setAnswer("");
    });
  const stop = () => send(() => api(`/api/control/tasks/${task!.id}/stop`, { method: "POST" }));

  const form = (
      <details className="ct-new">
        <summary>{L("לתת למחשב משימה", "Give the computer a task")}</summary>
        <p className="muted small" dir="auto">
          {L(
            "משפט אחד, ו־KesherAI עושה את הצעדים במחשב בעצמו: קורא את החלון, לוחץ וכותב, ומחזיר סיכום וצילום מסך. הוא לא מקליד סיסמאות, לא קונה ולא מוחק לצמיתות.",
            "One sentence, and KesherAI does the steps on the computer itself: it reads the window, presses and types, and gives back a summary and a screenshot. It never types passwords, buys or deletes for good.",
          )}
        </p>
        {!enabled && <p className="small error" dir="auto">{L("שליטה במחשב כבויה: הדליקו אותה בהגדרות ← שליטה במחשב.", "Computer control is off: turn it on in Settings → Computer control.")}</p>}
        <textarea className="ct-goal" rows={2} dir="auto" maxLength={2000} value={goal} onChange={(e) => setGoal(e.target.value)} placeholder={L("למשל: להתקין את Unreal 5.5 מה־Epic Launcher", "e.g. Install Unreal 5.5 from the Epic launcher")} aria-label={L("המשימה", "The task")} />
        <input dir="ltr" value={apps} onChange={(e) => setApps(e.target.value)} placeholder="EpicGamesLauncher, notepad" aria-label={L("אפליקציות שמותר לו לפעול בהן (בפסיקים)", "Apps it may act in (commas)")} />
        <p className="muted small" dir="auto">{L("אפליקציה שלא כתובה כאן — ישאל אותך קודם.", "For an app not named here, it asks you first.")}</p>
        <button type="button" className="primary" disabled={busy || !enabled || !goal.trim()} onClick={() => void start()}>
          {L("התחל", "Start")}
        </button>
        {!task && error && <p className="error small">{error}</p>}
      </details>
  );
  if (!task) return form;
  return (
    <>
    <section className={`ct-card ct-${task.status}`} aria-label={L("משימת מחשב", "Computer task")}>
      <div className="ct-head">
        <span className="ct-who" aria-hidden="true">🖥</span>
        <div className="ct-title">
          <strong dir="auto">{task.goal}</strong>
          <span className="muted small">
            <span className={`ct-chip ct-chip-${task.status}`}>{STATUS[task.status]()}</span> · {L(`צעד ${task.step} מתוך ${task.maxSteps}`, `Step ${task.step} of ${task.maxSteps}`)}
            {task.planner ? ` · ${task.planner === "gemini" ? "Gemini" : L("מודל מקומי", "Local model")}` : ""}
          </span>
        </div>
        {live && (
          <button type="button" className="ct-stop" disabled={busy} onClick={() => void stop()}>
            ■ {L("עצור", "Stop")}
          </button>
        )}
      </div>

      {task.status === "needs-you" && (
        <div className="ct-ask">
          <p dir="auto">{task.question}</p>
          <div className="ct-answer">
            <input dir="auto" value={answer} maxLength={1000} onChange={(e) => setAnswer(e.target.value)} onKeyDown={(e) => e.key === "Enter" && answer.trim() && void reply()} placeholder={L("התשובה שלך (כן, או מה לעשות)", "Your answer (yes, or what to do)")} aria-label={L("התשובה שלך", "Your answer")} />
            <button type="button" disabled={busy} onClick={() => void send(async () => { await api(`/api/control/tasks/${task.id}/answer`, { method: "POST", body: { text: "yes" } }); })}>{L("כן", "Yes")}</button>
            <button type="button" className="primary" disabled={busy || !answer.trim()} onClick={() => void reply()}>{L("שלח", "Send")}</button>
          </div>
        </div>
      )}

      {task.summary && <p className="ct-summary" dir="auto">{task.summary}</p>}
      {task.lastShot && !live && <img className="ct-shot" src={task.lastShot} alt={L("צילום המסך האחרון", "The last screenshot")} />}

      {task.steps.length > 0 && (
        <details className="ct-steps" open={!!live}>
          <summary>▸ {L(`הצעדים (${task.steps.length})`, `Steps (${task.steps.length})`)}</summary>
          <ol>
            {task.steps.slice(-8).map((s) => (
              <li key={s.n} className={s.ok ? "" : "bad"}>
                {s.shotThumb && <img src={s.shotThumb} alt="" loading="lazy" />}
                <span dir="auto">
                  <b dir="ltr">{s.n}.</b> {getLocale() === "he" ? stepWordHe(s.action) : s.action}
                  {s.note ? <span className="muted"> — {s.note}</span> : null}
                </span>
              </li>
            ))}
          </ol>
        </details>
      )}
      {error && <p className="error small">{error}</p>}
    </section>
    {!live && form}
    </>
  );
}

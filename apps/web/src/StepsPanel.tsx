/**
 * The Steps pane: the steps of the task the model is working on, ticked as it goes (the list Claude shows beside
 * a conversation). The model writes the list with its `set_steps` tool; the latest call is the list. A model
 * that does not use the tool still gets a list: the folded groups of its tool calls, one line each, so the pane
 * is never empty while work happens.
 */
import type { AgentEvent } from "@kesher/shared";
import { getLocale } from "./i18n";

const L = (he: string, en: string) => (getLocale() === "he" ? he : en);

/** One step as shown. */
export interface ShownStep { text: string; status: "pending" | "doing" | "done" }

/**
 * @param events - The conversation's events.
 * @returns The latest list the model set (empty when it set none), and whether it belongs to the last request.
 */
export function currentSteps(events: AgentEvent[]): { steps: ShownStep[]; current: boolean } {
  let lastUser = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.type === "user" && lastUser < 0) lastUser = i;
    if (e.type !== "tool_call" || e.name !== "set_steps") continue;
    const raw = (e.input as { steps?: unknown }).steps;
    if (!Array.isArray(raw)) continue;
    const steps = raw.flatMap((s): ShownStep[] => {
      const text = String((s as { text?: unknown })?.text ?? "").trim();
      const st = String((s as { status?: unknown })?.status ?? "");
      return text ? [{ text, status: st === "done" || st === "completed" ? "done" : st === "doing" || st === "in_progress" ? "doing" : "pending" }] : [];
    });
    if (steps.length) return { steps, current: i > lastUser };
  }
  return { steps: [], current: false };
}

/**
 * @param props.steps - The list.
 * @param props.busy - Whether the model is working now.
 * @param props.fallback - Lines to show when the model set no steps (its folded tool groups).
 * @param props.onClose - Closes the pane.
 */
export function StepsPanel({ steps, busy, fallback, onClose }: { steps: ShownStep[]; busy: boolean; fallback: string[]; onClose: () => void }) {
  const done = steps.filter((s) => s.status === "done").length;
  return (
    <section className="steps-panel card" aria-label={L("שלבים", "Steps")}>
      <div className="row steps-head">
        <strong className="grow">{L("שלבים", "Steps")}{steps.length > 0 && <span className="muted small"> · {done}/{steps.length}</span>}</strong>
        <button type="button" className="icon-btn" aria-label={L("סגור", "Close")} onClick={onClose}>✕</button>
      </div>
      {steps.length > 0 ? (
        <>
          <div className="steps-bar" role="progressbar" aria-valuemin={0} aria-valuemax={steps.length} aria-valuenow={done}><span style={{ width: `${(done / steps.length) * 100}%` }} /></div>
          <ol className="steps-list">
            {steps.map((s, i) => (
              <li key={i} className={`step ${s.status}${s.status === "doing" && busy ? " live" : ""}`}>
                <span className="step-mark" role="img" aria-label={s.status === "done" ? L("בוצע", "Done") : s.status === "doing" ? L("בעבודה", "In progress") : L("ממתין", "Waiting")} />
                <span dir="auto">{s.text}</span>
              </li>
            ))}
          </ol>
        </>
      ) : fallback.length > 0 ? (
        <>
          <p className="muted small">{L("המודל לא כתב רשימת שלבים. זה מה שהוא עשה עד עכשיו:", "The model wrote no list of steps. This is what it did so far:")}</p>
          <ol className="steps-list">
            {fallback.map((text, i) => (
              <li key={i} className={`step ${i === fallback.length - 1 && busy ? "doing live" : "done"}`}><span className="step-mark" aria-hidden="true" /><span dir="auto">{text}</span></li>
            ))}
          </ol>
        </>
      ) : (
        <p className="muted small">{L("כשהמודל עובד על משימה עם כמה שלבים, הם מופיעים כאן ומסומנים תוך כדי העבודה.", "When the model works on a task with several steps, they show here and are ticked as the work goes.")}</p>
      )}
    </section>
  );
}

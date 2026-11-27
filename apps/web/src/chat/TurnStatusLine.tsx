import { useEffect, useState } from "react";
import { getLocale, he$ } from "../i18n";
import { loadingBackText, useStandby } from "../standby";
import { clock, speedText, type TurnStatus, type TurnSummary } from "../turn-status";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);

/**
 * The live line under a busy answer (as Claude and Cursor): elapsed time (m:ss), the speed when the model reported
 * tokens, the step ("Step 2: make_music"; the count is the tool calls so far, the total is not known) and a badge while
 * an approval waits (turn-status.ts). Its own clock ticks once a second, so the page around it does not render again
 * for the time alone. Numbers and tool names are isolated (`bdi`, `dir="ltr"`) so Hebrew text does not reorder them.
 *
 * @param props.status - What the turn does (from turnStatus).
 * @param props.local - The chat's model runs on this computer (only then does a game's Play make it wait).
 * @param props.todo - The agent's task list of this turn, while steps are left: "· 3/7 tasks" (todo-view.ts).
 */
export function TurnStatusLine({ status, local = false, todo }: { status: TurnStatus; local?: boolean; todo?: { done: number; total: number } }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, []);
  // A turn sent while the models are away for a game's Play waits for them instead of failing.
  const standby = useStandby();
  const tool = status.tool ? <bdi className="mono" dir="ltr">{status.tool}</bdi> : null;
  const step = status.step > 0 ? <>{L("שלב", "Step")} <bdi dir="ltr">{status.step}</bdi></> : null;
  const what =
    status.kind === "approval" ? <span className="turn-badge">{L("מחכה לאישור שלך", "Waiting for your approval")}</span>
    : status.kind === "question" ? L("מחכה לתשובה שלך", "Waiting for your answer")
    : status.kind === "tool" ? <>{step ?? L("מריץ", "Running")}: {tool}</>
    : status.kind === "writing" ? L("כותב", "Writing")
    : local && standby?.state === "paused" ? loadingBackText()
    : L("חושב", "Thinking");
  const since = status.since ? Date.parse(status.since) : NaN;
  return (
    <p className={`muted status-line turn-status ${status.kind}`}>
      <span className="turn-dot" aria-hidden="true" />
      {/* Only what it does is announced; the clock would be read out every second. */}
      <span role="status">{what}</span>
      {status.kind === "approval" && tool && <span>{tool}</span>}
      {step && status.kind !== "tool" && <span>· {step}</span>}
      {todo && <span>· <bdi dir="ltr">{todo.done}/{todo.total}</bdi> {L("משימות", "tasks")}</span>}
      {Number.isFinite(since) && <span className="turn-time" dir="ltr" aria-hidden="true">· {clock(now - since)}</span>}
      {status.tps && <span className="turn-time" dir="ltr" aria-hidden="true">· {speedText(status.tps)}</span>}
    </p>
  );
}

/**
 * The line a turn collapses to when it ends: "Done in 0:42 · 38 tok/s" (the same height as the live line, so the
 * thread does not jump).
 *
 * @param props.summary - How the turn went (from turnSummary).
 */
export function TurnDoneLine({ summary }: { summary: TurnSummary }) {
  return (
    <p className="muted status-line turn-status done">
      <span>{L("הסתיים תוך", "Done in")} <bdi dir="ltr">{clock(summary.ms)}</bdi></span>
      {summary.tps && <span dir="ltr">· {speedText(summary.tps)}</span>}
    </p>
  );
}

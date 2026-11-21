import { useEffect, useState } from "react";
import { getLocale, he$ } from "../i18n";
import { shortDuration, type TurnStatus } from "../turn-status";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);

/**
 * The line under a busy answer: what the turn does now and how long it has run (turn-status.ts). Its own clock ticks
 * once a second, so the page around it does not render again for the time alone.
 *
 * @param props.status - What the turn does (from turnStatus).
 */
export function TurnStatusLine({ status }: { status: TurnStatus }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, []);
  const tool = status.tool ? <bdi className="mono" dir="ltr">{status.tool}</bdi> : null;
  const what =
    status.kind === "approval" ? <>{L("מחכה לאישור שלך", "Waiting for your approval")}{tool && <> · {tool}</>}</>
    : status.kind === "question" ? L("מחכה לתשובה שלך", "Waiting for your answer")
    : status.kind === "tool" ? <>{L("מריץ", "Running")} {tool}</>
    : status.kind === "writing" ? L("כותב", "Writing")
    : L("חושב", "Thinking");
  const since = status.since ? Date.parse(status.since) : NaN;
  return (
    <p className={`muted status-line turn-status ${status.kind}`}>
      <span className="turn-dot" aria-hidden="true" />
      {/* Only what it does is announced; the clock would be read out every second. */}
      <span role="status">{what}</span>
      {Number.isFinite(since) && <span className="turn-time" dir="ltr" aria-hidden="true"> · {shortDuration(now - since)}</span>}
    </p>
  );
}

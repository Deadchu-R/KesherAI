import { t, type StringKey } from "./i18n";

/** A performance estimate from the server (see estimatePerformance). */
export interface Estimate {
  rating: "good" | "ok" | "slow" | "too-big";
  tokensPerSecond: number;
  wordsPerSecond: number;
  tasks: Array<{ task: "short-answer" | "long-answer" | "load" | "read-file"; seconds: number }>;
}

function duration(seconds: number): string {
  if (seconds < 1) return "<1 s";
  if (seconds < 90) return `~${Math.round(seconds)} s`;
  return `~${Math.round(seconds / 60)} min`;
}

/** A coloured badge: runs well / OK / slow / too big. */
export function RatingBadge({ e }: { e: Estimate }) {
  const cls = e.rating === "good" ? "good" : e.rating === "ok" ? "warn" : "bad";
  const keys: Record<Estimate["rating"], StringKey> = { good: "ratingGood", ok: "ratingOk", slow: "ratingSlow", "too-big": "ratingToo-big" };
  const label = t(keys[e.rating]);
  return (
    <span className={`pill ${cls}`} title={e.rating === "too-big" ? "" : t("perSecond", { n: e.wordsPerSecond })}>
      {label}
      {e.rating !== "too-big" ? ` · ${t("perSecond", { n: e.wordsPerSecond })}` : ""}
    </span>
  );
}

/** The badge plus expected times for everyday tasks. */
export function EstimateDetails({ e }: { e: Estimate }) {
  return (
    <div className="estimate">
      <RatingBadge e={e} />
      {e.tasks.length > 0 && (
        <ul className="tasks">
          {e.tasks.map((task) => (
            <li key={task.task}>
              <span className="muted">{t(`task-${task.task}` as StringKey)}</span> <span className="mono" dir="ltr">{duration(task.seconds)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

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

/** Speed measured on this computer from real answers. */
export interface Measured {
  tps: number;
  n: number;
}

/** A coloured badge: runs well / OK / slow / too big. Once the model ran here, the measured speed replaces the estimate. */
export function RatingBadge({ e, measured }: { e: Estimate; measured?: Measured | undefined }) {
  const rating: Estimate["rating"] = measured ? (measured.tps >= 15 ? "good" : measured.tps >= 6 ? "ok" : "slow") : e.rating;
  const cls = rating === "good" ? "good" : rating === "ok" ? "warn" : "bad";
  const keys: Record<Estimate["rating"], StringKey> = { good: "ratingGood", ok: "ratingOk", slow: "ratingSlow", "too-big": "ratingToo-big" };
  const words = measured ? Math.round(measured.tps * 0.75 * 10) / 10 : e.wordsPerSecond;
  const speed = measured ? t("measuredPerSecond", { n: words }) : t("perSecond", { n: words });
  return (
    <span className={`pill ${cls}`} title={measured ? t("measuredHint", { n: measured.n }) : rating === "too-big" ? "" : speed}>
      {t(keys[rating])}
      {rating !== "too-big" ? ` · ${speed}` : ""}
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

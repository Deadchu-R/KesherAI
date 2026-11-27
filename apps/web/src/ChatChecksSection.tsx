import { useEffect, useState } from "react";
import { api, isRemote } from "./api";
import { getLocale, he$ } from "./i18n";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);

/** One scenario's outcome (packages/core/src/chat-checks/runner.ts). */
interface CheckResult {
  id: string;
  he: string;
  en: string;
  state: "pending" | "running" | "pass" | "fail" | "skip";
  check?: string;
  reason?: string;
  ms?: number;
}

/** One run of the chat checks. */
interface CheckRun {
  id: string;
  model: string;
  state: "running" | "done" | "failed";
  startedAt: string;
  finishedAt?: string;
  error?: string;
  results: CheckResult[];
}

/** `GET /api/chat-checks`. */
interface ChecksInfo {
  runs: CheckRun[];
  running?: string | null;
  model?: string | null;
  canRun: boolean;
}

const MARK: Record<CheckResult["state"], string> = { pass: "✅", fail: "❌", skip: "⏭️", running: "🔄", pending: "⬜" };

/** @returns "9/12": passed out of the scenarios that ran (skipped ones do not count). */
function scoreOf(results: readonly Pick<CheckResult, "state">[]): { pass: number; of: number } {
  const pass = results.filter((r) => r.state === "pass").length;
  return { pass, of: pass + results.filter((r) => r.state === "fail").length };
}

/**
 * Settings › For developers › Chat checks: runs KesherAI's "behaves like Claude" scenarios on this computer with the
 * selected chat model, and shows the score and each scenario with ✅/❌ and the reason. The phone views only.
 */
export function ChatChecksSection() {
  const [info, setInfo] = useState<ChecksInfo | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState("");
  const load = () => void api<ChecksInfo>("/api/chat-checks").then(setInfo, () => setInfo(null));
  useEffect(load, []);
  // While a run goes, follow it every 3 s.
  const going = !!info?.running;
  useEffect(() => {
    if (!going) return;
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [going]);
  if (!info) return null;
  const run = info.runs.find((r) => r.id === open) ?? info.runs[0];
  const canRun = info.canRun && !isRemote();
  const start = () => {
    setError("");
    void api<{ job: string }>("/api/chat-checks/run", { method: "POST", body: {} }).then(
      (r) => {
        setOpen(r.job);
        load();
      },
      (e: Error) => setError(e.message),
    );
  };
  const when = (iso: string) => new Date(iso).toLocaleString(getLocale() === "he" ? "he-IL" : "en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  const secs = (ms?: number) => (ms ? `${Math.round(ms / 1000)} ${L("שנ'", "s")}` : "");
  const score = run ? scoreOf(run.results) : undefined;
  return (
    <section className="card stack" id="settings-chat-checks">
      <h2>{L("בדיקות צ'אט", "Chat checks")}</h2>
      <p className="muted small">{L("תרחישים שבודקים אם הצ'אט מתנהג כמו Claude (כלים נכונים, שאלה לפני עבודה יקרה, תשובה קצרה בשפה שלך). רצים כאן במחשב, בצ'אטים זמניים בגלישה בסתר שנמחקים אחר כך, עם המודל הנבחר; אישורים ניתנים רק לדפי הבדיקה המקומיים ולתיקייה הזמנית.", "Scenarios that check whether the chat behaves like Claude (the right tools, a question before costly work, a short answer in your language). They run here on the computer, in temporary incognito chats that are deleted afterwards, with the selected model; approvals are given only to the local test pages and the temporary folder.")}</p>
      <div className="row" style={{ flexWrap: "wrap" }}>
        <span className="grow small" dir="auto">
          {L("מודל", "Model")}: <code dir="ltr">{run?.state === "running" ? run.model : (info.model ?? L("לא נבחר", "none chosen"))}</code>
        </span>
        {canRun ? (
          info.running ? (
            <button type="button" onClick={() => void api("/api/chat-checks/stop", { method: "POST" }).then(load)}>{L("עצור", "Stop")}</button>
          ) : (
            <button type="button" className="primary" disabled={!info.model} onClick={start}>{L("הרץ", "Run")}</button>
          )
        ) : null}
      </div>
      {!canRun && <p className="muted small">{L("הרצה אפשרית רק במחשב עצמו; מכאן אפשר לצפות בתוצאות.", "Runs start only on the computer itself; here you can view the results.")}</p>}
      {error && <p className="small" role="alert" dir="auto">{error}</p>}
      {run ? (
        <div className="stack">
          <div className="row" style={{ flexWrap: "wrap", alignItems: "baseline" }}>
            <strong style={{ fontSize: "1.6rem" }} dir="ltr">{score!.pass}/{score!.of}</strong>
            <span className="muted small grow" dir="auto">
              {run.state === "running" ? L("רץ עכשיו…", "Running…") : run.state === "failed" ? `${L("נכשל", "Failed")}: ${run.error ?? ""}` : L("עברו", "passed")}
              {" · "}
              {when(run.startedAt)}
            </span>
            {info.runs.length > 1 && (
              <select value={run.id} aria-label={L("הרצה", "Run")} onChange={(e) => setOpen(e.target.value)}>
                {info.runs.map((r) => {
                  const s = scoreOf(r.results);
                  return <option key={r.id} value={r.id}>{`${when(r.startedAt)} · ${s.pass}/${s.of}`}</option>;
                })}
              </select>
            )}
          </div>
          <ul className="plain-list">
            {run.results.map((r) => (
              <li key={r.id} className="row" style={{ alignItems: "flex-start" }}>
                <span aria-hidden="true">{MARK[r.state]}</span>
                <span className="grow" style={{ minWidth: 0 }}>
                  <span dir="auto">{getLocale() === "he" ? r.he : r.en}</span>
                  {r.reason && (
                    <span className="muted small" style={{ display: "block", overflowWrap: "anywhere" }} dir="ltr">
                      {r.check ? `${r.check}: ` : ""}
                      {r.reason}
                    </span>
                  )}
                </span>
                <span className="muted small" style={{ whiteSpace: "nowrap" }}>{secs(r.ms)}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="muted small">{L("עוד לא הורצו בדיקות.", "No checks have run yet.")}</p>
      )}
    </section>
  );
}

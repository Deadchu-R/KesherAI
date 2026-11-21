import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import { getLocale, he$ } from "./i18n";
import { localAgentState, restartBody, type LocalAgentRun } from "./local-agent";
import { toast } from "./library";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);

/**
 * "The local agent is not running" next to a task that waits for it (a local-model task such as "Convert with AI"
 * sits on the task board until self-work takes it). Shows nothing while the agent works. The Start button starts
 * self-work again with the last run's project and check (POST /api/self-work/start, like the Self-work page; it also
 * works from the phone, which may start only the same project); with no earlier run it links to the Self-work page.
 * It never starts by itself.
 *
 * @param props.className - Extra class for the notice.
 */
export function LocalAgentNotice({ className = "" }: { className?: string }) {
  const [run, setRun] = useState<LocalAgentRun | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => api<{ run: LocalAgentRun | null }>("/api/self-work").then((r) => setRun(r.run), () => undefined), []);
  useEffect(() => {
    void load();
    const t = window.setInterval(() => !document.hidden && void load(), 10_000);
    return () => window.clearInterval(t);
  }, [load]);
  if (run === undefined) return null;
  const state = localAgentState(run);
  if (state === "on") return null;
  const start = async () => {
    if (!run) return;
    setBusy(true);
    try {
      await api("/api/self-work/start", { method: "POST", body: restartBody(run) });
      await load();
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <p className={`local-agent-off small ${className}`.trim()} role="status" dir="auto">
      ⚠ {L("המודל המקומי לא פועל עכשיו", "The local agent is not running")}
      {" — "}
      {state === "off-restart" ? (
        <button type="button" className="primary" disabled={busy} onClick={() => void start()}>▶ {L("הפעל", "Start")}</button>
      ) : (
        <a className="btn" href="#/self-work">{L("הפעל בעבודה עצמית", "Start on the Self-work page")}</a>
      )}
    </p>
  );
}

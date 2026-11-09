import { useEffect, useState } from "react";
import { api } from "./api";
import { getLocale } from "./i18n";
import { toast } from "./library";
import { TaskBoardView } from "./TaskBoardView";

const L = (he: string, en: string) => (getLocale() === "he" ? he : en);

interface Run {
  repo: string;
  goal: string;
  branch: string;
  check: string;
  convId: string;
  status: "running" | "waiting" | "done" | "blocked" | "stopped" | "failed";
  until: number;
  steps: number;
  items: Array<{ at: number; text: string; commit?: string }>;
  note?: string;
}

const STATUS: Record<Run["status"], [string, string]> = {
  running: ["🤖 עובד", "🤖 Working"],
  waiting: ["✋ מחכה לאישור שלך", "✋ Waiting for your approval"],
  done: ["✅ סיים", "✅ Finished"],
  blocked: ["✋ צריך אותך", "✋ Needs you"],
  stopped: ["⏹ נעצר", "⏹ Stopped"],
  failed: ["⛔ נכשל", "⛔ Failed"],
};

/**
 * Self-work: KesherAI works on the chosen git project by itself for hours,
 * on its own branch, one item at a time, running the project's check and
 * committing after each item, with a phone notification per item.
 *
 * @param p.folder - The project folder chosen on the code screen.
 */
export function SelfWorkPanel(p: { folder: string }) {
  const [run, setRun] = useState<Run | null>(null);
  const [open, setOpen] = useState(false);
  const [goal, setGoal] = useState("");
  const [hours, setHours] = useState(2);
  const [check, setCheck] = useState("");
  const [busy, setBusy] = useState(false);
  // What the run did lately, and what it waits for (it runs in the worker, whose chat has no window here).
  const [log, setLog] = useState<{ lines: string[]; waiting: Array<{ requestId: string; name: string; preview: string; reason: string }> }>({ lines: [], waiting: [] });

  useEffect(() => {
    let alive = true;
    const load = () => void api<{ run: Run | null }>("/api/self-work").then((r) => {
      if (!alive) return;
      setRun(r.run);
      if (r.run && !check) setCheck(r.run.check);
      if (r.run && (r.run.status === "running" || r.run.status === "waiting")) void api<typeof log>("/api/self-work/log").then((l) => alive && setLog({ lines: l.lines ?? [], waiting: l.waiting ?? [] }), () => undefined);
    }, () => undefined);
    load();
    const t = window.setInterval(load, 5000);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, [check]);

  const active = run && (run.status === "running" || run.status === "waiting");
  const start = async () => {
    setBusy(true);
    try {
      const r = await api<{ run: Run }>("/api/self-work/start", { method: "POST", body: { repo: p.folder, goal, hours, check } });
      setRun(r.run);
      setGoal("");
      toast(L(`התחיל לעבוד על הענף ${r.run.branch}`, `Started on the branch ${r.run.branch}`));
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const stop = () => void api<{ run: Run | null }>("/api/self-work/stop", { method: "POST" }).then((r) => setRun(r.run), (e: Error) => toast(e.message));

  return (
    <section className="self-work">
      <button type="button" className="self-work-head" aria-expanded={open || !!active} onClick={() => setOpen((v) => !v)}>
        <span>🤖 {L("עבודה עצמית", "Self-work")}</span>
        {run && <span className="muted small">{L(...STATUS[run.status])}{active ? ` · ${run.items.length} ${L("פריטים", "items")}` : ""}</span>}
      </button>
      {(open || active) && (
        <div className="self-work-body">
          {active && run ? (
            <>
              <p dir="auto">{run.goal}</p>
              <p className="muted small" dir="ltr">{run.branch} · {L("עד", "until")} {new Date(run.until).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</p>
              {run.note && <p className="small">{run.note}</p>}
              {log.waiting.map((w) => (
                <div key={w.requestId} className="card approval">
                  <strong>✋ {L("מחכה לאישור שלך", "Waiting for your approval")}: <code>{w.name}</code></strong>
                  <p className="muted small">{w.reason}</p>
                  <pre className="code" dir="ltr">{w.preview}</pre>
                  <div className="row">
                    <button type="button" className="primary" onClick={() => void api("/api/self-work/approve", { method: "POST", body: { requestId: w.requestId, decision: "allow" } }).then(() => setLog((x) => ({ ...x, waiting: x.waiting.filter((y) => y.requestId !== w.requestId) })), (e: Error) => toast(e.message))}>{L("אשר", "Allow")}</button>
                    <button type="button" onClick={() => void api("/api/self-work/approve", { method: "POST", body: { requestId: w.requestId, decision: "deny" } }).then(() => setLog((x) => ({ ...x, waiting: x.waiting.filter((y) => y.requestId !== w.requestId) })), (e: Error) => toast(e.message))}>{L("דחה", "Deny")}</button>
                  </div>
                </div>
              ))}
              <ul className="self-work-items">
                {run.items.map((i) => <li key={i.at}>✓ <span dir="auto">{i.text}</span>{i.commit && <code className="muted small"> {i.commit}</code>}</li>)}
              </ul>
              {log.lines.length > 0 && (
                <details className="self-work-log">
                  <summary className="small">{L("מה הוא עושה עכשיו", "What it is doing now")}</summary>
                  <ol className="small" dir="auto">{log.lines.slice(-25).map((l, i) => <li key={i}>{l}</li>)}</ol>
                </details>
              )}
              <div className="row">
                <button type="button" onClick={stop}>{L("עצור", "Stop")}</button>
              </div>
            </>
          ) : (
            <>
              <p className="muted small">{L("KesherAI עובד לבד על הפרויקט שבחרתם: ענף חדש, פריט אחד בכל פעם, בדיקה וקומיט אחרי כל פריט, והתראה לטלפון. הוא אף פעם לא דוחף ולא ממזג.", "KesherAI works on the chosen project by itself: a new branch, one item at a time, a check and a commit after each item, and a phone notification. It never pushes or merges.")}</p>
              {run && <p className="small">{L("הריצה הקודמת", "Last run")}: {L(...STATUS[run.status])}{run.note ? ` · ${run.note}` : ""} · {run.items.length} {L("פריטים", "items")} · <span dir="ltr">{run.branch}</span></p>}
              <textarea dir="auto" rows={3} value={goal} placeholder={L("על מה לעבוד? למשל: לתקן את כל אזהרות ה-lint בתיקיית apps/web", "What to work on? e.g. fix every lint warning in apps/web")} onChange={(e) => setGoal(e.target.value)} />
              <div className="row wrap">
                <label className="small">{L("שעות", "Hours")} <select value={hours} onChange={(e) => setHours(Number(e.target.value))}>{[0.5, 1, 2, 4, 8].map((h) => <option key={h} value={h}>{h}</option>)}</select></label>
                <input dir="ltr" className="grow" value={check} placeholder={L("בדיקה אחרי כל פריט, למשל pnpm test", "Check after each item, e.g. pnpm test")} onChange={(e) => setCheck(e.target.value)} />
                <button type="button" className="primary" disabled={busy || !goal.trim() || !p.folder} onClick={() => void start()} title={p.folder ? p.folder : L("בחרו תיקייה למעלה", "Choose a folder above")}>{L("התחל", "Start")}</button>
              </div>
            </>
          )}
          <TaskBoardView />
        </div>
      )}
    </section>
  );
}

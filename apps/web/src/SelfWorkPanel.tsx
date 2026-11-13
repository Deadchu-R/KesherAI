import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import { getLocale } from "./i18n";
import { toast } from "./library";
import { TaskBoardView } from "./TaskBoardView";
import { Select } from "./ui/Select";

const L = (he: string, en: string) => (getLocale() === "he" ? he : en);

interface Run {
  modelId?: string;
  repo: string;
  goal: string;
  branch: string;
  check: string;
  convId: string;
  status: "running" | "waiting" | "done" | "blocked" | "stopped" | "failed";
  until: number;
  steps: number;
  items: Array<{ at: number; text: string; commit?: string }>;
  skipped?: Array<{ at: number; why: string }>;
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
export function SelfWorkPanel(p: { folder: string; startOpen?: boolean }) {
  const [run, setRun] = useState<Run | null>(null);
  const [open, setOpen] = useState(!!p.startOpen);
  const [goal, setGoal] = useState("");
  const [hours, setHours] = useState(2);
  const [check, setCheck] = useState("");
  const [busy, setBusy] = useState(false);
  // What the run did lately, and what it waits for (it runs in the worker, whose chat has no window here).
  const [log, setLog] = useState<{ lines: string[]; waiting: Array<{ requestId: string; name: string; preview: string; reason: string }>; steps?: Array<{ text: string; status: "pending" | "doing" | "done" }> }>({ lines: [], waiting: [] });
  // The task it holds on the board now (found on the phone: "0 items" and a closed log said nothing about it).
  const [onTask, setOnTask] = useState<{ id: string; title: string } | null>(null);
  // Each new request is brought into view once.
  const seenAsk = useRef(new Set<string>());

  useEffect(() => {
    let alive = true;
    const load = () => void api<{ run: Run | null }>("/api/self-work").then((r) => {
      if (!alive) return;
      setRun(r.run);
      if (r.run && !check) setCheck(r.run.check);
      if (r.run && (r.run.status === "running" || r.run.status === "waiting")) void api<typeof log>("/api/self-work/log").then((l) => alive && setLog({ lines: l.lines ?? [], waiting: l.waiting ?? [], steps: l.steps ?? [] }), () => undefined);
      if (r.run && (r.run.status === "running" || r.run.status === "waiting"))
        void api<{ tasks: Array<{ id: string; title: string; status: string; owner?: string }> }>("/api/self-work/board").then((b) => {
          const held = b.tasks.find((x) => x.status === "claimed" && x.owner === "kesher");
          if (alive) setOnTask(held ? { id: held.id, title: held.title.replace(/^\s*\[cool\s*down\]\s*/i, "") } : null);
        }, () => undefined);
    }, () => undefined);
    load();
    const t = window.setInterval(() => !document.hidden && load(), 5000);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, [check]);

  const active = run && (run.status === "running" || run.status === "waiting");
  const start = async () => {
    setBusy(true);
    try {
      const r = await api<{ run: Run; picked?: { id: string; why: string }; contextNote?: string }>("/api/self-work/start", { method: "POST", body: { repo: p.folder, goal, hours, check } });
      setRun(r.run);
      setGoal("");
      if (r.contextNote) toast(r.contextNote);
      toast(L(`התחיל לעבוד על הענף ${r.run.branch}${r.picked ? ` עם ${r.picked.id.split("/").pop()} (${r.picked.why})` : ""}`, `Started on the branch ${r.run.branch}${r.picked ? ` with ${r.picked.id.split("/").pop()} (${r.picked.why})` : ""}`));
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const [nightly, setNightly] = useState("01:00");
  const [copies, setCopies] = useState<string | null>(null);
  useEffect(() => {
    void api<{ folder: string | null }>("/api/self-work/folder").then((r) => setCopies(r.folder ?? ""), () => setCopies(null));
  }, []);
  const saveCopies = () => void api<{ folder: string | null }>("/api/self-work/folder", { method: "PUT", body: { folder: copies || null } }).then((r) => toast(r.folder ? L(`העותקים יישמרו ב־${r.folder}`, `Copies go to ${r.folder}`) : L("העותקים יישמרו ליד הפרויקט", "Copies go next to the project")), (e: Error) => toast(e.message));
  // The same run, every night (a routine; it shows in Pipelines → Routines too, where it can be changed or removed).
  const saveNightly = () =>
    void api("/api/routines", {
      method: "POST",
      body: { name: L(`עבודה עצמית כל לילה: ${goal.slice(0, 40)}`, `Self-work every night: ${goal.slice(0, 40)}`), enabled: true, notify: true, schedule: { kind: "daily", time: nightly }, action: { type: "self-work", repo: p.folder, goal, hours, check } },
    }).then(() => toast(L(`נשמר: כל לילה ב־${nightly}`, `Saved: every night at ${nightly}`)), (e: Error) => toast(e.message));
  const stop = () => void api<{ run: Run | null }>("/api/self-work/stop", { method: "POST" }).then((r) => setRun(r.run), (e: Error) => toast(e.message));
  const resume = () => void api<{ run: Run | null }>("/api/self-work/resume", { method: "POST", body: { hours } }).then((r) => setRun(r.run), (e: Error) => toast(e.message));

  return (
    <section className="self-work">
      <button type="button" className="self-work-head" aria-expanded={open || !!active} onClick={() => setOpen((v) => !v)}>
        <span>🤖 {L("עבודה עצמית", "Self-work")}</span>
        {log.waiting.length > 0 && <span className="pill small warn">✋ {L(`מחכה לאישור (${log.waiting.length})`, `Waiting for approval (${log.waiting.length})`)}</span>}
        {run && <span className="muted small">{L(...STATUS[run.status])}{active ? ` · ${run.items.length} ${L("הושלמו", "done")}` : ""}</span>}
      </button>
      {(open || active) && (
        <div className="self-work-body">
          {active && run ? (
            <>
              {/* Approvals first: answered right here, from the computer or the phone (Roee: without leaving self-work). */}
              {log.waiting.map((w) => (
                <div key={w.requestId} className="card approval self-work-approval" ref={(el) => { if (el && !seenAsk.current.has(w.requestId)) { seenAsk.current.add(w.requestId); el.scrollIntoView({ block: "center", behavior: "smooth" }); } }}>
                  <strong>✋ {L("מחכה לאישור שלך", "Waiting for your approval")}: <code>{w.name}</code></strong>
                  <p className="muted small">{w.reason}</p>
                  <pre className="code" dir="ltr">{w.preview}</pre>
                  <div className="row">
                    <button type="button" className="primary" onClick={() => void api("/api/self-work/approve", { method: "POST", body: { requestId: w.requestId, decision: "allow" } }).then(() => setLog((x) => ({ ...x, waiting: x.waiting.filter((y) => y.requestId !== w.requestId) })), (e: Error) => toast(e.message))}>{L("אשר", "Allow")}</button>
                    <button type="button" onClick={() => void api("/api/self-work/approve", { method: "POST", body: { requestId: w.requestId, decision: "deny" } }).then(() => setLog((x) => ({ ...x, waiting: x.waiting.filter((y) => y.requestId !== w.requestId) })), (e: Error) => toast(e.message))}>{L("דחה", "Deny")}</button>
                  </div>
                </div>
              ))}
              {onTask && <p className="self-work-now" dir="auto">🔧 <strong>{L("עובד על", "Working on")} {onTask.id}:</strong> {onTask.title}</p>}
              <p className="muted small" dir="auto">{run.goal}</p>
              <p className="muted small" dir="ltr">{run.branch} · {L("עד", "until")} {new Date(run.until).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}{run.modelId ? ` · ${run.modelId.replace(/^main\//, "").split("/").pop()}` : ""}</p>
              {run.note && <p className="small">{run.note}</p>}
              <ul className="self-work-items">
                {run.items.map((i) => <li key={i.at}>✓ <span dir="auto">{i.text}</span>{i.commit && <code className="muted small"> {i.commit}</code>}</li>)}
                {(run.skipped ?? []).map((i) => <li key={`s${i.at}`} className="muted">↷ {L("דילג", "Skipped")}: <span dir="auto">{i.why}</span></li>)}
              </ul>
              {(log.steps?.length ?? 0) > 0 && (
                <div className="self-work-steps">
                  <strong className="small">{L("שלבי המשימה הנוכחית", "Steps of the current task")} · {log.steps!.filter((x) => x.status === "done").length}/{log.steps!.length}</strong>
                  <ol className="steps-list">
                    {log.steps!.map((x, i) => (
                      <li key={i} className={`step ${x.status}${x.status === "doing" && run.status === "running" ? " live" : ""}`}><span className="step-mark" aria-hidden="true" /><span dir="auto">{x.text}</span></li>
                    ))}
                  </ol>
                </div>
              )}
              {log.lines.length > 0 && (
                <details className="self-work-log" open>
                  <summary className="small">{L("מה הוא עושה עכשיו", "What it is doing now")}: <span dir="auto">{log.lines.at(-1)!.slice(0, 90)}</span></summary>
                  <ol className="small" dir="auto" reversed>{log.lines.slice(-12).reverse().map((l, i) => <li key={i}>{l}</li>)}</ol>
                </details>
              )}
              <div className="row">
                <button type="button" onClick={stop}>{L("עצור", "Stop")}</button>
              </div>
            </>
          ) : (
            <>
              <p className="muted small">{L("KesherAI עובד לבד על הפרויקט שבחרתם: ענף חדש, פריט אחד בכל פעם, בדיקה וקומיט אחרי כל פריט, והתראה לטלפון. הוא אף פעם לא דוחף ולא ממזג.", "KesherAI works on the chosen project by itself: a new branch, one item at a time, a check and a commit after each item, and a phone notification. It never pushes or merges.")}</p>
              {run && <p className="small">{L("הריצה הקודמת", "Last run")}: {L(...STATUS[run.status])}{run.note ? ` · ${run.note}` : ""} · {run.items.length} {L("הושלמו", "done")} · <span dir="ltr">{run.branch}</span></p>}
              {run && run.status !== "done" && (
                <div className="row wrap">
                  <button type="button" onClick={resume} title={L("ממשיך את אותה ריצה מאיפה שעצרה: אותו ענף, אותו צ'אט, הפריטים שכבר נעשו נשארים", "Goes on with the same run where it ended: same branch and chat; finished items stay")}>{L("↻ המשך מאיפה שעצר", "↻ Resume where it stopped")}</button>
                </div>
              )}
              <textarea dir="auto" rows={3} value={goal} placeholder={L("על מה לעבוד? למשל: לתקן את כל אזהרות ה-lint בתיקיית apps/web", "What to work on? e.g. fix every lint warning in apps/web")} onChange={(e) => setGoal(e.target.value)} />
              <div className="row wrap">
                <label className="small">{L("שעות", "Hours")} <Select value={hours} onChange={(e) => setHours(Number(e.target.value))}>{[0.5, 1, 2, 4, 8].map((h) => <option key={h} value={h}>{h}</option>)}</Select></label>
                <input dir="ltr" className="grow" value={check} placeholder={L("בדיקה אחרי כל פריט, למשל pnpm test", "Check after each item, e.g. pnpm test")} onChange={(e) => setCheck(e.target.value)} />
                <button type="button" className="primary" disabled={busy || !goal.trim() || !p.folder} onClick={() => void start()} title={p.folder ? p.folder : L("בחרו תיקייה למעלה", "Choose a folder above")}>{L("התחל", "Start")}</button>
              </div>
              <div className="row wrap">
                <label className="small">{L("או כל לילה בשעה", "Or every night at")} <input type="time" value={nightly} onChange={(e) => setNightly(e.target.value)} /></label>
                <button type="button" disabled={!goal.trim() || !p.folder} onClick={saveNightly} title={L("שומר את זה כשגרה: מתחיל לבד כל לילה (אם קשר פועל), עם התראה", "Saves it as a routine: starts by itself every night (while KesherAI runs), with a notification")}>{L("שמירה כשגרה", "Save as a routine")}</button>
              </div>
              {copies !== null && (
                <div className="row wrap">
                  <label className="small grow">{L("איפה לשמור את העותקים (למשל כונן גדול)", "Where to keep the copies (e.g. a big drive)")} <input dir="ltr" value={copies} placeholder={L("ליד הפרויקט", "Next to the project")} onChange={(e) => setCopies(e.target.value)} /></label>
                  <button type="button" onClick={saveCopies}>{L("שמירה", "Save")}</button>
                </div>
              )}
            </>
          )}
          <TaskBoardView />
        </div>
      )}
    </section>
  );
}

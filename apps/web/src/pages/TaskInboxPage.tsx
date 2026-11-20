/**
 * The task inbox (`#/task-inbox`, `#/task-inbox/<id>`; packages/core/src/inbox-runner.ts): the queue of coding tasks
 * Claude (or Roee, or the Kesher Cloud hub) sent through the `kesher-inbox` branch, with each task's executor, state
 * and branch; the PC's "Run this task in Antigravity?" asks (answered here or on the phone, one tap = one task); the
 * quota card; "+ Task"; and a task's own page (spec, live plan, the policy's decisions, an asked step, the diff,
 * KesherAI's checks and the result). Everything goes through `/api/task-inbox`, so the phone in remote gets the same
 * page; at 390 px the table becomes cards.
 */
import { useEffect, useState } from "react";
import { agentDoing, assignOfExecutor, INBOX_GIT_MISSING, WORK_LIST_STATUSES, type AgentLabel, type WorkListItem, type InboxState, type InboxStatus, type InboxTaskView } from "@kesher/shared";
import { api } from "../api";
import { getLocale, he$ } from "../i18n";
import { toast } from "../library";
import { AgentLabelEditor, AgentLabelLines } from "../AgentLabel";
import { AssignPicker } from "../AssignPicker";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);

/** A status's chip: its words and colour. */
function statusChip(t: InboxTaskView): { text: string; cls: string } {
  const step = t.plan?.length ? ` · ${L("שלב", "step")} ${Math.min(t.plan.filter((p) => p.status === "completed").length + 1, t.plan.length)}/${t.plan.length}` : "";
  const m: Record<InboxStatus, [string, string, string]> = {
    waiting: [t.runBy === "antigravity" ? 'ממתין ל"הפעל"' : "ממתין", t.runBy === "antigravity" ? "Waiting for Run" : "Waiting", ""],
    queued: [t.runBy === "opus" ? "בתור" : "בתור לעבודה עצמית", t.runBy === "opus" ? "Queued" : "Queued for self-work", ""],
    running: [`רץ${step}`, `Running${step}`, "run"],
    "needs-approval": ["🔔 צריך אישור", "🔔 Needs approval", "ask"],
    done: ["✓ הסתיים", "✓ Done", "good"],
    partial: ["◐ חלקי", "◐ Partial", "warn"],
    failed: ["✕ נכשל", "✕ Failed", "bad"],
    declined: ["✕ נדחה", "✕ Declined", "bad"],
    "deferred-quota": ["⏸ נדחה: מכסה", "⏸ Deferred: quota", "warn"],
    skipped: ["דולג", "Skipped", ""],
  };
  const [he, en, cls] = m[t.status];
  return { text: L(he, en), cls };
}

/** The executor's chip. */
function executorChip(runBy: InboxTaskView["runBy"]): { text: string; cls: string } {
  if (runBy === "antigravity") return { text: "✦ Antigravity", cls: "agy" };
  if (runBy === "local") return { text: L("◆ מודל מקומי", "◆ Local model"), cls: "local" };
  return { text: L("✷ סוכן Opus", "✷ Opus agent"), cls: "opus" };
}

const fromName = (f: InboxTaskView["from"]) => ({ claude: "Claude", roee: L("רועי", "Roee"), "self-work": L("עבודה עצמית", "self-work"), hub: L("ענן Kesher", "Kesher Cloud"), device: L("מכשיר אחר", "another device") })[f];

/** "2 min ago" / "in 1 h 35 min". */
function ago(ms: number): string {
  const min = Math.max(0, Math.round(Math.abs(ms) / 60_000));
  const h = Math.floor(min / 60);
  const txt = h ? L(`${h} שע׳ ו-${min % 60} דק׳`, `${h} h ${min % 60} min`) : L(`${min} דק׳`, `${min} min`);
  return ms >= 0 ? L(`לפני ${txt}`, `${txt} ago`) : L(`בעוד ${txt}`, `in ${txt}`);
}

const clock = (at: number) => new Date(at).toLocaleTimeString(getLocale() === "he" ? "he-IL" : "en-GB", { hour: "2-digit", minute: "2-digit" });

/** The rules KesherAI's policy names, in Hebrew. */
function ruleText(rule: string): string {
  const he: Record<string, string> = {
    "on the command list": "ברשימת הפקודות",
    "not on the command list": "לא ברשימה המותרת",
    "only KesherAI commits and pushes": "רק KesherAI מבצע קומיט ודוחף",
    "git history and branches are KesherAI's": "היסטוריה וענפים של git רק דרך KesherAI",
    "no installs": "בלי התקנות",
    "no network": "בלי רשת",
    "secret files": "קבצי סודות",
    "outside the worktree": "מחוץ לתיקיית העבודה",
    "reading inside the project": "קריאה בתוך הפרויקט",
    "inside the allowed paths": "בתוך הנתיבים המותרים",
    "outside the allowed paths": "מחוץ לנתיבים המותרים",
    "a forbidden path": "נתיב אסור",
    "an unknown kind of step": "סוג צעד לא מוכר",
    "not allowed in a task": "לא מותר במשימה",
  };
  return getLocale() === "he" ? he$(he[rule] ?? rule) : rule;
}

/** What to paste to Claude for its review. */
function forClaude(t: InboxTaskView): string {
  return [`Inbox ${t.id}: ${t.status}`, `Branch: ${t.pushed ? t.branch : "(not pushed)"}${t.headSha ? ` @ ${t.headSha.slice(0, 7)}` : ""}`, `Checks: ${(t.checks ?? []).map((c) => `${c.name} ${c.ok ? "ok" : "FAIL"}`).join(", ") || "none"}`, `Result: results/${t.id}.md on kesher-inbox`, ...(t.note ? [`Note: ${t.note}`] : [])].join("\n");
}

/** The page. */
export function TaskInboxPage({ id }: { id?: string }) {
  const [s, setS] = useState<InboxState | null>(null);
  const [filter, setFilter] = useState<"all" | "waiting" | "running" | "ask" | "ended">("all");
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const load = () => void api<InboxState>("/api/task-inbox").then(setS, () => undefined);
  useEffect(() => {
    load();
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, []);
  const act = async (path: string, body: unknown = {}) => {
    setBusy(true);
    try {
      await api(path, { method: "POST", body });
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
      load();
    }
  };
  if (!s) return <div className="page"><h1>📥 {L("תיבת משימות", "Task inbox")}</h1></div>;
  if (id) return <TaskPage id={id} state={s} act={act} busy={busy} />;

  const counts = {
    all: s.tasks.length,
    waiting: s.tasks.filter((t) => t.status === "waiting" || t.status === "queued").length,
    running: s.tasks.filter((t) => t.status === "running").length,
    ask: s.tasks.filter((t) => t.status === "needs-approval" || t.runAsk).length,
    ended: s.tasks.filter((t) => ["done", "partial", "failed", "declined", "skipped", "deferred-quota"].includes(t.status)).length,
  };
  const shown = s.tasks.filter((t) => filter === "all" || (filter === "waiting" ? t.status === "waiting" || t.status === "queued" : filter === "running" ? t.status === "running" : filter === "ask" ? t.status === "needs-approval" || !!t.runAsk : ["done", "partial", "failed", "declined", "skipped", "deferred-quota"].includes(t.status)));
  const asks = s.tasks.filter((t) => t.runAsk && t.runAsk.until > Date.now());
  const local = s.tasks.filter((t) => t.runBy === "local").length;
  const put = (body: Record<string, unknown>) => void api("/api/task-inbox/settings", { method: "PUT", body }).then(load, (e) => toast((e as Error).message));

  return (
    <div className="page stack tinbox">
      <div className="row tinbox-head">
        <h1 className="grow">📥 {L("תיבת משימות", "Task inbox")}</h1>
        <span className="tinbox-chip">✦ {L("Antigravity היום:", "Antigravity today:")} <b>{s.today.used}/{s.settings.dailyCap}</b></span>
        <span className="tinbox-chip hide-phone">{L("◆ מודל מקומי:", "◆ Local model:")} {local}</span>
        <label className="row small">
          <input type="checkbox" checked={s.settings.enabled} onChange={(e) => put({ enabled: e.target.checked })} /> {L("התיבה פעילה", "Inbox on")}
        </label>
        <button type="button" disabled={!s.settings.enabled} onClick={() => put({ paused: !s.settings.paused })}>{s.settings.paused ? L("▶ המשך", "▶ Resume") : L("⏸ השהה", "⏸ Pause")}</button>
        <button type="button" className="primary" onClick={() => setAdding(true)}>{L("＋ משימה", "＋ Task")}</button>
      </div>

      <div className="row wrap small tinbox-status">
        <span className={`tinbox-chip ${s.busy.free ? "good" : "warn"}`}>● {s.busy.free ? L("המחשב פנוי", "The PC is free") : L("המחשב עסוק", "The PC is busy")}{s.busy.reasons.length ? `: ${s.busy.reasons.join(", ")}` : s.busy.gpu !== undefined ? `: GPU ${s.busy.gpu}%` : ""}{!s.busy.free && L(" · Antigravity רץ בכל זאת (בענן)", " · Antigravity still runs (in the cloud)")}</span>
        <span className="tinbox-chip" dir="ltr">⟳ {s.settings.branch}{s.lastFetch ? ` · ${ago(Date.now() - s.lastFetch)}` : ""}</span>
        <button type="button" className="chip-text" disabled={busy || !s.settings.enabled} onClick={() => void act("/api/task-inbox/sync")}>{L("בדוק עכשיו", "Check now")}</button>
      </div>
      {s.lastError && (
        <p className="small tinbox-err" dir="auto">
          {s.lastError === INBOX_GIT_MISSING
            ? L("Git לא מותקן במחשב (או שלא נמצא): התקן את Git for Windows מ-git-scm.com (או winget install Git.Git) והפעל מחדש את KesherAI.", "Git for Windows is not installed / not found: install it from git-scm.com (or winget install Git.Git) and restart KesherAI.")
            : s.lastError}
        </p>
      )}
      {!s.settings.repo && <p className="muted">{L("עוד לא נבחר פרויקט. ", "No project yet. ")}<a href="#/settings/inbox">{L("הגדרות › תיבת משימות", "Settings › Task inbox")}</a></p>}

      <TermsNote />

      {s.quota && (
        <section className="card tinbox-quota">
          <p><b>⏸ {L(`הגעת למכסה של Gemini. Antigravity יוכל לעבוד שוב ב-${clock(s.quota.until)} (${ago(Date.now() - s.quota.until)})`, `You reached Gemini's quota. Antigravity can work again at ${clock(s.quota.until)} (${ago(Date.now() - s.quota.until)})`)}{s.quota.estimated ? L(" · הערכה", " · estimate") : ""}</b></p>
          {s.quota.taskId && <p className="small muted">{L(`המשימה ${s.quota.taskId} נעצרה באמצע. מה שנעשה נשמר בענף חלקי, ושום דבר לא נדחף ל-main.`, `Task ${s.quota.taskId} stopped midway. What was done is kept on a partial branch, and nothing went to main.`)}</p>}
          {s.quota.taskId && (
            <div className="row wrap">
              <button type="button" disabled={busy} onClick={() => void act(`/api/task-inbox/tasks/${s.quota!.taskId}/reassign`, { to: "local" })}>{L("◆ העבר למודל המקומי", "◆ Move to the local model")}</button>
              <button type="button" disabled={busy} onClick={() => void act(`/api/task-inbox/tasks/${s.quota!.taskId}/reassign`, { to: "opus" })}>{L("✷ החזר ל-Claude (סוכן Opus)", "✷ Give back to Claude (Opus agent)")}</button>
            </div>
          )}
          <p className="small muted">{L("גם אחרי זה זה לא ירוץ לבד: ההפעלה תמיד בלחיצה שלך. המודל המקומי ממשיך כרגיל.", "Even then it will not run by itself: it always starts on your tap. The local model goes on as usual.")}</p>
        </section>
      )}

      {asks.map((t) => <RunAsk key={t.id} t={t} state={s} act={act} busy={busy} />)}

      {adding && <AddTask onDone={() => { setAdding(false); load(); }} />}

      <div className="row wrap tinbox-filters" role="tablist">
        {([["all", "הכול", "All"], ["waiting", "ממתינות", "Waiting"], ["running", "רצות", "Running"], ["ask", "צריך אישור", "Needs approval"], ["ended", "הסתיימו", "Ended"]] as const).map(([k, he, en]) => (
          <button key={k} type="button" role="tab" aria-selected={filter === k} className={`chip-text${filter === k ? " on" : ""}`} onClick={() => setFilter(k)}>{L(he, en)} {counts[k]}</button>
        ))}
      </div>

      <div className="card tinbox-table">
        <div className="tinbox-row tinbox-th small muted">
          <span>#</span><span>{L("משימה", "Task")}</span><span>{L("מבצע", "Executor")}</span><span>{L("מצב", "State")}</span><span>{L("ענף", "Branch")}</span><span />
        </div>
        {!shown.length && <p className="muted tinbox-empty">{s.tasks.length ? L("אין משימות כאן.", "No tasks here.") : L("עוד אין משימות. Claude כותב אותן לענף kesher-inbox, או הוסיפו אחת כאן.", "No tasks yet. Claude writes them to the kesher-inbox branch, or add one here.")}</p>}
        {shown.map((t) => <QueueRow key={t.id} t={t} state={s} act={act} busy={busy} onAssigned={load} />)}
      </div>

      <WorkListSend onSent={load} />

      <div className="row wrap small tinbox-legend">
        <span><span className="tinbox-ex agy">✦ Antigravity</span> {L("3–15 קבצים, משימה מוגדרת עם בדיקה", "3–15 files, a defined task with a check")}</span>
        <span><span className="tinbox-ex local">{L("◆ מודל מקומי", "◆ Local model")}</span> {L("1–2 קבצים, שינוי מכני", "1–2 files, a mechanical change")}</span>
        <span><span className="tinbox-ex opus">{L("✷ סוכן Opus", "✷ Opus agent")}</span> {L("קשה, מסוכן או אבטחה", "hard, risky or security")}</span>
      </div>
      <p className="small muted">↩ {L("כל משימה חוזרת כענף ב-GitHub. Claude בודק את השינויים ואת תוצאות הבדיקות, וממזג או מחזיר עם תיקון. KesherAI דוחף רק ענפי agy/* ואת kesher-inbox, אף פעם לא את main.", "Every task comes back as a branch on GitHub. Claude reviews the changes and the check results, and merges or sends it back with a fix. KesherAI pushes only agy/* branches and kesher-inbox, never main.")}</p>
    </div>
  );
}

/**
 * Claude's work list (docs/WORK_LIST.md), its open items, each with "Send to an agent" (board InboxWorkList): the
 * item becomes an inbox task for the chosen executor, or goes to a chat agent. Folded until opened.
 */
function WorkListSend({ onSent }: { onSent: () => void }) {
  const [items, setItems] = useState<WorkListItem[] | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (open && !items) void api<{ items: WorkListItem[] }>("/api/task-inbox/work-list").then((r) => setItems(r.items), () => setItems([]));
  }, [open, items]);
  const order = (i: WorkListItem) => WORK_LIST_STATUSES.indexOf(i.status);
  return (
    <section className="card stack tinbox-wl">
      <button type="button" className="link row" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <b className="grow">📋 {L("רשימת העבודה של Claude: לשלוח לסוכן", "Claude's work list: send to an agent")}</b>
        <span aria-hidden>{open ? "▴" : "▾"}</span>
      </button>
      {open && !items && <p className="small muted">{L("טוען…", "Loading…")}</p>}
      {open && items && !items.length && <p className="small muted">{L("אין פריטים פתוחים (או שאין פרויקט לתיבה).", "No open items (or no project for the inbox).")}</p>}
      {open &&
        items &&
        [...items].sort((a, b) => order(a) - order(b) || a.order - b.order).map((i) => (
          <div key={i.id} className="tinbox-wl-item">
            <div className="grow tinbox-wl-t" dir="auto">
              <span className="small muted">{i.section} · </span>
              {i.title}
            </div>
            <AssignPicker id={i.id} label={L("שלח לסוכן", "Send to an agent")} onDone={onSent} />
          </div>
        ))}
    </section>
  );
}

/** Google's terms for a personal plan, in one short note (docs/RESEARCH_LOG.md, the 2026-11-19 terms entry). */
function TermsNote() {
  return (
    <p className="small muted tinbox-terms">
      {L("Antigravity רץ רק כשאתה לוחץ \"הפעל\" (במחשב, או בתשובה לשאלה בטלפון), משימה אחת בכל לחיצה, לפי מכסת התוכנית שלך. לעבודה בלי השגחה עדיף מפתח API של AI Studio או Jules (", "Antigravity runs only when you tap Run (on the PC, or answering its ask on the phone), one task per tap, within your plan's quota. For unattended work, an AI Studio API key or Jules is the better path (")}
      <span className="tinbox-later">{L("Jules: בהמשך", "Jules: later")}</span>).
    </p>
  );
}

type Act = (path: string, body?: unknown) => Promise<void>;

/** The PC's question "Run this task in Antigravity?", with what the user needs to decide. */
function RunAsk({ t, state, act, busy }: { t: InboxTaskView; state: InboxState; act: Act; busy: boolean }) {
  const ask = t.runAsk!;
  return (
    <section className="card tinbox-ask" aria-live="polite">
      <div className="row wrap">
        <b className="grow">✦ {L("להריץ את המשימה ב-Antigravity?", "Run this task in Antigravity?")}</b>
        <span className="small muted">{L(`פג תוקף ${ago(Date.now() - ask.until)}`, `Expires ${ago(Date.now() - ask.until)}`)}</span>
      </div>
      <p><b>{t.title}</b> <span className="small muted" dir="ltr">{t.id}</span></p>
      <p className="tinbox-goal">{t.goal.slice(0, 600)}</p>
      <div className="row wrap small muted">
        <span>{L("פרויקט:", "Project:")} <b dir="ltr">{state.project ?? "?"}</b></span>
        <span>{L("ענף:", "Branch:")} <b dir="ltr">{t.branch}</b></span>
        <span>{L("נשארו היום:", "Left today:")} <b>{ask.left}</b></span>
        <span>{L("מאת", "From")} {fromName(t.from)}</span>
      </div>
      <div className="row wrap">
        <button type="button" className="primary" disabled={busy} onClick={() => void act("/api/task-inbox/run-answer", { requestId: ask.requestId, decision: "allow" })}>▶ {L("הפעל", "Run")}</button>
        <button type="button" disabled={busy} onClick={() => void act("/api/task-inbox/run-answer", { requestId: ask.requestId, decision: "deny" })}>{L("לא עכשיו", "Not now")}</button>
      </div>
      <p className="small muted">{L("לחיצה אחת מריצה את המשימה הזו בלבד. השאלה פגה אחרי 30 דקות.", "One tap runs this one task only. The ask expires after 30 minutes.")}</p>
    </section>
  );
}

/** One task in the queue: a table row on the computer, a card on the phone. */
function QueueRow({ t, state, act, busy, onAssigned }: { t: InboxTaskView; state: InboxState; act: Act; busy: boolean; onAssigned: () => void }) {
  const st = statusChip(t);
  const ex = executorChip(t.runBy);
  const open = () => (location.hash = `#/task-inbox/${t.id}`);
  const runnable = t.runBy === "antigravity" && ["waiting", "failed", "partial", "deferred-quota"].includes(t.status);
  const copy = () => void navigator.clipboard?.writeText(forClaude(t)).then(() => toast(L("הועתק", "Copied")), () => toast(forClaude(t)));
  return (
    <div className="tinbox-row">
      <span className="tinbox-id small muted" dir="ltr">{t.id}</span>
      <div className="tinbox-title">
        <button type="button" className="link" onClick={open} dir="auto">{t.label?.name || t.title}</button>
        {t.label?.name && <div className="small muted alab-sub" dir="auto">{t.title}</div>}
        {t.label?.note && <div className="small alab-note" dir="auto">📝 {t.label.note}</div>}
        <div className="small tinbox-from">{L("מאת", "From")} {fromName(t.from)}</div>
      </div>
      <span><span className={`tinbox-ex ${ex.cls}`}>{ex.text}</span></span>
      <span><span className={`tinbox-st ${st.cls}`}>{st.text}</span></span>
      <span className="tinbox-branch small muted" dir="ltr" title={t.branch}>{t.branch}</span>
      <span className="row tinbox-actions">
        {(t.status === "running" || t.status === "needs-approval") && <button type="button" className="danger" disabled={busy} onClick={() => void act(`/api/task-inbox/tasks/${t.id}/stop`)}>■ {L("עצור", "Stop")}</button>}
        {t.status === "needs-approval" && <button type="button" onClick={open}>{L("אשר / דחה", "Allow / Deny")}</button>}
        {runnable && state.runHere && <button type="button" className="primary" disabled={busy} onClick={() => void act(`/api/task-inbox/tasks/${t.id}/run`)}>▶ {t.status === "waiting" ? L("הפעל", "Run") : L("נסה שוב", "Retry")}</button>}
        {runnable && !state.runHere && !t.runAsk && <button type="button" disabled={busy} onClick={() => void act(`/api/task-inbox/tasks/${t.id}/ask`)}>▶ {L("הפעל", "Run")}</button>}
        {t.status === "waiting" && <button type="button" disabled={busy} onClick={() => void act(`/api/task-inbox/tasks/${t.id}/skip`)}>{L("דלג", "Skip")}</button>}
        {t.status === "done" && <button type="button" onClick={copy}>📋 {L("העתק ל-Claude", "Copy for Claude")}</button>}
        {t.runBy === "opus" && t.status === "queued" && <span className="small muted">{L("Claude מריץ", "Claude runs it")}</span>}
        {["running", "needs-approval", "partial", "failed", "deferred-quota", "declined"].includes(t.status) && <button type="button" onClick={open}>{L("פתח", "Open")}</button>}
        {t.status !== "declined" && t.status !== "skipped" && <AssignPicker id={t.id} current={assignOfExecutor(t.runBy)} onDone={onAssigned} />}
      </span>
    </div>
  );
}

/** "+ Task": the phone's (and the PC's) own task; it goes to the inbox branch so Claude sees it too. */
function AddTask({ onDone }: { onDone: () => void }) {
  const [f, setF] = useState({ title: "", goal: "", acceptance: "", check: "pnpm -s typecheck", executor: "auto", risk: "medium" });
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      await api("/api/task-inbox/tasks", { method: "POST", body: f });
      onDone();
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return (
    <section className="card stack tinbox-add">
      <h2>{L("＋ משימה חדשה", "＋ New task")}</h2>
      <label className="stack"><span className="small muted">{L("כותרת", "Title")}</span><input value={f.title} maxLength={200} onChange={set("title")} /></label>
      <label className="stack"><span className="small muted">{L("מטרה", "Goal")}</span><textarea rows={3} value={f.goal} maxLength={6000} onChange={set("goal")} /></label>
      <label className="stack"><span className="small muted">{L("קבלה (איך יודעים שזה עובד)", "Acceptance (how to tell it works)")}</span><textarea rows={2} value={f.acceptance} onChange={set("acceptance")} /></label>
      <label className="stack"><span className="small muted">{L("בדיקה (רק פקודות מהרשימה המותרת ירוצו)", "Check (only commands on the allowed list run)")}</span><input dir="ltr" value={f.check} onChange={set("check")} /></label>
      <div className="row wrap">
        <label className="row small">{L("מבצע", "Executor")}
          <select value={f.executor} onChange={set("executor")}>
            <option value="auto">{L("אוטומטי", "Auto")}</option>
            <option value="antigravity">✦ Antigravity</option>
            <option value="local">{L("◆ מודל מקומי", "◆ Local model")}</option>
            <option value="opus">{L("✷ סוכן Opus", "✷ Opus agent")}</option>
          </select>
        </label>
        <label className="row small">{L("סיכון", "Risk")}
          <select value={f.risk} onChange={set("risk")}>
            <option value="low">{L("נמוך", "Low")}</option>
            <option value="medium">{L("בינוני", "Medium")}</option>
            <option value="high">{L("גבוה", "High")}</option>
          </select>
        </label>
      </div>
      <div className="row">
        <button type="button" className="primary" disabled={busy || !f.title.trim() || !f.goal.trim()} onClick={() => void save()}>{L("הוסף", "Add")}</button>
        <button type="button" onClick={onDone}>{L("ביטול", "Cancel")}</button>
      </div>
    </section>
  );
}

/** A task's own page: the spec, the live plan, the policy, an asked step, the changes, the checks and the result. */
function TaskPage({ id, state, act, busy }: { id: string; state: InboxState; act: Act; busy: boolean }) {
  const [t, setT] = useState<InboxTaskView | null>(null);
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    const get = () => void api<InboxTaskView>(`/api/task-inbox/tasks/${encodeURIComponent(id)}`).then(setT, () => setT(null));
    get();
    const timer = setInterval(get, 3000);
    return () => clearInterval(timer);
  }, [id]);
  if (!t) return <div className="page"><p><a href="#/task-inbox">📥 {L("תיבת משימות", "Task inbox")}</a></p></div>;
  const st = statusChip(t);
  const ex = executorChip(t.runBy);
  const auto = (t.decisions ?? []).filter((d) => d.verdict === "allow").length;
  const denied = (t.decisions ?? []).filter((d) => d.verdict === "deny");
  const minutes = t.startedAt && t.endedAt ? Math.round((t.endedAt - t.startedAt) / 6000) / 10 : undefined;
  const copy = () => void navigator.clipboard?.writeText(forClaude(t)).then(() => toast(L("הועתק", "Copied")), () => toast(forClaude(t)));
  return (
    <div className="page stack tinbox tinbox-task">
      <p className="small"><a href="#/task-inbox">📥 {L("תיבת משימות", "Task inbox")}</a> › <span dir="ltr">{t.id}</span></p>
      <div className="row wrap">
        <h1 className="grow" dir="auto">{t.label?.name || t.title}</h1>
        <button type="button" aria-expanded={editing} onClick={() => setEditing((e) => !e)}>✎ {t.label?.name || t.label?.note ? L("ערוך שם והערה", "Edit name & note") : L("שם והערה", "Name & note")}</button>
        <span className={`tinbox-ex ${ex.cls}`}>{ex.text}{t.modelUsed ? ` · ${t.modelUsed}` : ""}</span>
        <span className={`tinbox-st ${st.cls}`}>{st.text}{minutes !== undefined ? ` · ${minutes} ${L("דק׳", "min")}` : ""}</span>
        {(t.status === "running" || t.status === "needs-approval") && <button type="button" className="danger" disabled={busy} onClick={() => void act(`/api/task-inbox/tasks/${t.id}/stop`)}>■ {L("עצור", "Stop")}</button>}
        {t.status === "done" && <button type="button" onClick={copy}>📋 {L("העתק ל-Claude", "Copy for Claude")}</button>}
        {t.status !== "declined" && t.status !== "skipped" && <AssignPicker id={t.id} current={assignOfExecutor(t.runBy)} />}
      </div>
      <AgentLabelLines title={t.title} name={t.label?.name} note={t.label?.note} doing={t.status === "running" ? agentDoing({ state: "running", tool: t.decisions?.at(-1)?.what.split(/\s+/)[0] }) : undefined} />
      {editing && (
        <AgentLabelEditor
          title={t.title}
          label={t.label ?? {}}
          save={(l: AgentLabel) => api<{ label: AgentLabel }>(`/api/task-inbox/tasks/${encodeURIComponent(t.id)}/label`, { method: "PUT", body: l }).then((r) => setT({ ...t, label: r.label }))}
          onClose={() => setEditing(false)}
        />
      )}
      {t.runAsk && <RunAsk t={t} state={state} act={act} busy={busy} />}
      {t.note && <p className="small tinbox-err">{t.note}</p>}

      {t.pending && (
        <section className="card stack tinbox-approve">
          <div className="row wrap"><b className="grow">🔔 {L("Antigravity רוצה להריץ צעד שלא ברשימה המותרת", "Antigravity wants a step that is not on the allowed list")}</b><span className="small muted">{ago(Date.now() - t.pending.until)}</span></div>
          <pre className="tinbox-cmd" dir="ltr">$ {t.pending.what}{"\n"}# {L("ענף", "branch")}: {t.pending.where}</pre>
          {t.pending.why && <p className="small"><b>{L("למה הוא מבקש:", "Why it asks:")}</b> “{t.pending.why}”</p>}
          <p className="small"><b>{L("מה KesherAI אומר:", "What KesherAI says:")}</b> {ruleText(t.pending.rule)} → {L("נשאל אותך.", "so you are asked.")}</p>
          <div className="row wrap">
            <button type="button" className="primary" disabled={busy} onClick={() => void act(`/api/task-inbox/tasks/${t.id}/answer`, { requestId: t.pending!.requestId, decision: "allow" })}>✓ {L("אשר פעם אחת", "Allow once")}</button>
            <button type="button" disabled={busy} onClick={() => void act(`/api/task-inbox/tasks/${t.id}/answer`, { requestId: t.pending!.requestId, decision: "deny" })}>✕ {L("דחה", "Deny")}</button>
          </div>
          <p className="small muted">{L("בלי תשובה תוך 30 דקות: נדחה אוטומטית והמשימה ממשיכה בלי הצעד.", "No answer within 30 minutes: denied, and the task goes on without the step.")}</p>
        </section>
      )}

      <div className="tinbox-cols">
        <section className="card stack">
          <h2>{L(`המשימה (מ-${fromName(t.from)})`, `The task (from ${fromName(t.from)})`)}</h2>
          <div><b className="small">{L("מטרה", "Goal")}</b><p className="tinbox-goal">{t.goal}</p></div>
          {t.acceptance && <div><b className="small">{L("קבלה", "Acceptance")}</b><p className="tinbox-goal">{t.acceptance}</p></div>}
          {t.outOfScope && <div><b className="small">{L("מחוץ לתחום", "Out of scope")}</b><p className="tinbox-goal">{t.outOfScope}</p></div>}
          <div><b className="small">{L("נתיבים מותרים", "Allowed paths")}</b><div className="row wrap">{t.allowedPaths.map((p) => <code key={p} dir="ltr">{p}</code>)}</div></div>
          {t.check && <div><b className="small">{L("בדיקה", "Check")}</b> <code dir="ltr">{t.check}</code></div>}
          <p className="small muted">{L(`גבולות: ${t.maxMinutes} דק׳ · עד ${t.maxFiles} קבצים · סיכון ${t.risk === "low" ? "נמוך" : t.risk === "high" ? "גבוה" : "בינוני"}`, `Limits: ${t.maxMinutes} min · up to ${t.maxFiles} files · ${t.risk} risk`)}</p>
        </section>

        <section className="card stack">
          <h2>{L("תוכנית", "Plan")} <span className="small muted">{L("חי, מ-Antigravity", "live, from Antigravity")}</span></h2>
          {t.plan?.length ? <ul className="tinbox-plan">{t.plan.map((p, i) => <li key={i} className={p.status}>{p.status === "completed" ? "✓" : p.status === "in_progress" ? "▸" : "○"} {p.content}</li>)}</ul> : <p className="small muted">{L("עוד אין תוכנית.", "No plan yet.")}</p>}
          <b className="small">{L("אישורים בדרך", "Approvals on the way")}</b>
          <p className="small">{L(`אוטומטי · ${auto} צעדים לפי כלל`, `Automatic · ${auto} steps by rule`)}</p>
          {denied.slice(-6).map((d, i) => <p key={i} className="small"><span className="tinbox-st bad">{L("נדחה לפי כלל", "Denied by rule")}</span> <code dir="ltr">{d.what}</code> <span className="muted">({ruleText(d.rule)})</span></p>)}
          {(t.decisions ?? []).filter((d) => d.verdict === "ask").map((d, i) => <p key={`a${i}`} className="small"><span className="tinbox-st ask">{L("נשאל", "Asked")}</span> <code dir="ltr">{d.what}</code> → {d.answer === "allow" ? L("אושר", "allowed") : d.answer === "timeout" ? L("נדחה (אין תשובה)", "denied (no answer)") : d.answer ? L("נדחה", "denied") : L("מחכה", "waiting")}</p>)}
        </section>
      </div>

      {!!t.files?.length && (
        <section className="card stack">
          <div className="row"><h2 className="grow">{L("שינויים", "Changes")}</h2><span className="small muted">{t.files.length} {L("קבצים", "files")} · <span className="tinbox-plus">+{t.files.reduce((n, f) => n + f.added, 0)}</span> <span className="tinbox-minus">−{t.files.reduce((n, f) => n + f.removed, 0)}</span></span></div>
          {t.files.map((f) => <div key={f.path} className="small" dir="ltr">{f.path} <span className="tinbox-plus">+{f.added}</span> <span className="tinbox-minus">−{f.removed}</span></div>)}
          {t.diff && <pre className="tinbox-diff" dir="ltr">{t.diff.split("\n").slice(0, 400).map((l, i) => <div key={i} className={l.startsWith("+") && !l.startsWith("+++") ? "dp" : l.startsWith("-") && !l.startsWith("---") ? "dm" : l.startsWith("@@") ? "dh" : ""}>{l || " "}</div>)}</pre>}
        </section>
      )}

      {!!t.checks?.length && (
        <section className="card stack">
          <h2>{L("בדיקות של KesherAI", "KesherAI's checks")}</h2>
          {t.checks.map((c, i) => (
            <div key={i} className="row wrap small tinbox-check">
              <b className="grow">{c.name === "paths" ? L("נתיבים מותרים", "Allowed paths") : c.name === "secrets and privacy" ? L("סריקת סודות ופרטיות", "Secrets and privacy scan") : c.name}</b>
              {c.command && <code dir="ltr">{c.command}</code>}
              <span className={`tinbox-st ${c.ok ? "good" : "bad"}`}>{c.ok ? "✓" : "✕"} {c.note}</span>
            </div>
          ))}
          <p className="small muted">{L("הבדיקות רצות על ידי KesherAI עצמו, לא על ידי הסוכן, בעדיפות נמוכה.", "The checks are run by KesherAI itself, not by the agent, at low priority.")}</p>
        </section>
      )}

      {(t.pushed || t.summary) && (
        <section className="card stack">
          <h2>{L("תוצאה", "Result")}</h2>
          {t.pushed && <p className="small">{L("ענף", "Branch")} <code dir="ltr">{t.branch}</code> · {L("נדחף · קומיט", "pushed · commit")} <code dir="ltr">{(t.headSha ?? "").slice(0, 7)}</code>{t.resultWritten ? L(` · התוצאה נכתבה ל-results/${t.id}.md ב-kesher-inbox. Claude יבדוק וימזג.`, ` · the result is in results/${t.id}.md on kesher-inbox. Claude will review and merge.`) : ""}</p>}
          {t.summary && <p className="tinbox-goal small">{t.summary}</p>}
        </section>
      )}
    </div>
  );
}

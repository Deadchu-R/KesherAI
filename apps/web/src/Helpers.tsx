import { useEffect, useState } from "react";
import type { HelperRunInfo } from "@kesher/shared";
import { api } from "./api";
import { getLocale, he$ } from "./i18n";
import { RichText } from "./RichText";
import { toast } from "./library";
import { kTokens } from "./chat-status";

/**
 * Sub-agents in the chat (docs/RESEARCH_LOG.md, "Helper agents in the chat"; design boards HelpersStrip,
 * PhoneHelpersStrip, HelperModelSwap): the strip above the composer with the running and waiting ones, a card per
 * sub-agent in the thread (its model, state, steps and short report), the phone's bottom sheet for one run, and the
 * notice while a build agent's model is swapped in. Everything comes from the chat's own event stream (`helpers`
 * events), so the phone in remote shows the same.
 *
 * Steer and continue (RESEARCH_LOG "Gap list: agents and chat-first", A5 and A6): a running sub-agent's card and sheet
 * take a note ("Add a note"), read at its next step; an ended one can be continued with a follow-up ("Continue
 * with…"), from its own conversation on the same model. Both go through the server, so they work from the phone too.
 *
 * Wording (Roee, 2026-11-19): "סוכנים" / agents, never "עוזרים"; the chat's model is the lead agent, the others are
 * sub-agents ("סוכן מחקר", "research agent"…).
 */

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);

/** Icon and name per sub-agent type. */
const KINDS: Record<HelperRunInfo["kind"], { icon: string; he: string; en: string }> = {
  lookup: { icon: "🔎", he: "חיפוש", en: "Lookup" },
  research: { icon: "📚", he: "מחקר", en: "Research" },
  build: { icon: "🛠️", he: "בנייה", en: "Build" },
  external: { icon: "🛰️", he: "חיצוני", en: "Outside" },
};

/** @returns The type's short name ("מחקר"), or the named agent's. */
export function helperKindName(r: Pick<HelperRunInfo, "kind" | "agent">): string {
  return r.agent ? `@${r.agent}` : L(KINDS[r.kind].he, KINDS[r.kind].en);
}

/** @returns Whether the run is still going (waiting, asking or running). */
export const going = (r: HelperRunInfo) => r.state === "waiting" || r.state === "asking" || r.state === "running";

/** `m:ss`. */
export function clock(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** @returns How long it ran (or runs), or undefined while it waits. */
function elapsed(r: HelperRunInfo, now: number): number | undefined {
  return r.startedAt ? (r.endedAt ?? now) - r.startedAt : undefined;
}

/** Re-renders every second while something runs (the clocks). */
function useNow(active: boolean): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return active ? now : Date.now();
}

/**
 * A chat's sub-agent runs and the agents its `@` menu offers: loaded once, then kept from the chat's `helpers` events
 * (the caller passes them to `set`).
 *
 * @param convId - The chat.
 */
export function useHelperRuns(convId: string): { runs: HelperRunInfo[]; set: (runs: HelperRunInfo[]) => void; agents: Array<{ name: string; description?: string; builtin?: boolean; external?: boolean }> } {
  const [runs, set] = useState<HelperRunInfo[]>([]);
  const [agents, setAgents] = useState<Array<{ name: string; description?: string; builtin?: boolean; external?: boolean }>>([]);
  useEffect(() => {
    set([]);
    let gone = false;
    api<{ runs: HelperRunInfo[]; agents?: Array<{ name: string; description?: string; builtin?: boolean; external?: boolean }> }>(`/api/conversations/${convId}/helpers`).then(
      (r) => {
        if (gone) return;
        set(r.runs);
        setAgents(r.agents ?? []);
      },
      () => undefined,
    );
    return () => {
      gone = true;
    };
  }, [convId]);
  return { runs, set, agents };
}

const stop = (convId: string, id: string) => void api(`/api/conversations/${convId}/helpers/${id}/stop`, { method: "POST" }).catch(() => undefined);

/** The state's tag ("רץ · 2:10"). */
function StateTag({ r, now }: { r: HelperRunInfo; now: number }) {
  const t = elapsed(r, now);
  const [cls, he, en] =
    r.state === "running" ? ["t-run", "רץ", "Running"]
    : r.state === "waiting" && r.restart === "paused" ? ["t-wait", "הושהה בהפעלה מחדש", "Paused by restart"]
    : r.state === "waiting" ? ["t-wait", "ממתין", "Waiting"]
    : r.state === "asking" ? ["t-ask", "שואל", "Asking"]
    : r.state === "done" ? ["t-ok", "הסתיים", "Done"]
    : r.state === "failed" ? ["t-bad", "נכשל", "Failed"]
    : ["t-off", "נעצר", "Stopped"];
  return (
    <span className={`htag ${cls}`}>
      {L(he, en)} · <span className="mono">{t === undefined ? "—" : clock(t)}</span>
    </span>
  );
}

/** "Resumed" after a restart (the tag says "Paused by restart" before it continues). */
function ResumedTag({ r }: { r: HelperRunInfo }) {
  if (r.restart !== "resumed") return null;
  return <span className="htag t-run" title={L("KesherAI הופעל מחדש והסוכן ממשיך מהצעד שבו עצר", "KesherAI restarted and the helper goes on from the step where it stopped")}>↻ {L("חודש", "Resumed")}</span>;
}

/** "Continued" after a follow-up (how many times when more than once). */
function ContinuedTag({ r }: { r: HelperRunInfo }) {
  if (!r.continued) return null;
  const n = r.continued > 1 ? ` ×${r.continued}` : "";
  return <span className="htag t-run" title={L("הסוכן הזה הוסיף לעבוד מהשיחה שלו עם הנחיה חדשה", "This agent went on from its own conversation with a follow-up")}>↪ {L("המשך", "Continued")}{n}</span>;
}

/** A note or follow-up line in the steps (`note(user): …`, `continue(lead): …`), as helper-runs.ts writes it. */
const NOTE_STEP = /^(note|continue)\((user|lead)\): ([\s\S]*)$/;

/** @returns The step as the user reads it: a tool step as is, a note or a follow-up with who sent it. */
function stepText(step: string): { text: string; note: boolean } {
  const m = NOTE_STEP.exec(step);
  if (!m) return { text: step, note: false };
  const who = m[1] === "note"
    ? (m[2] === "user" ? L("ההנחיה שלך", "Your note") : L("הנחיה מהסוכן הראשי", "Lead agent's note"))
    : (m[2] === "user" ? L("המשך ממך", "Your follow-up") : L("המשך מהסוכן הראשי", "Lead agent's follow-up"));
  return { text: `${who}: ${m[3]}`, note: true };
}

/**
 * The note box on a running sub-agent ("Add a note"), or "Continue with…" on an ended one that kept its conversation.
 * The note is read at its next step (after the tool it runs now); a follow-up starts it again in the background.
 *
 * @param p.r - The run.
 * @param p.convId - The chat.
 */
function HelperTalk({ r, convId }: { r: HelperRunInfo; convId: string }) {
  const [text, setText] = useState("");
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const live = going(r) && r.kind !== "external";
  if (!live && !r.canContinue) return null;
  if (!live && !open) {
    return (
      <div className="htalk-row">
        <button type="button" className="hbtn" onClick={() => setOpen(true)}>↪ {L("המשך עם…", "Continue with…")}</button>
      </div>
    );
  }
  const send = () => {
    const t = text.trim();
    if (!t || busy) return;
    setBusy(true);
    void api(`/api/conversations/${convId}/helpers/${r.id}/${live ? "message" : "continue"}`, { method: "POST", body: { text: t } }).then(
      () => {
        setText("");
        setOpen(false);
        toast(live ? L("ההנחיה נשלחה: הסוכן יקרא אותה בצעד הבא", "Note sent: the agent reads it at its next step") : L("הסוכן ממשיך ברקע", "The agent goes on in the background"));
      },
      (e) => toast((e as Error).message),
    ).finally(() => setBusy(false));
  };
  const label = live ? L("הוסף הנחיה", "Add a note") : L("המשך עם…", "Continue with…");
  return (
    <form className="htalk" onSubmit={(e) => { e.preventDefault(); send(); }}>
      <input
        type="text"
        value={text}
        maxLength={2000}
        dir="auto"
        aria-label={label}
        placeholder={live ? L("הוסף הנחיה: מה לשנות או להוסיף…", "Add a note: what to change or add…") : L("המשך עם: מה לעשות עכשיו…", "Continue with: what to do next…")}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Escape" && !live) setOpen(false); }}
        autoFocus={!live}
      />
      <button type="submit" className="primary" disabled={!text.trim() || busy}>{live ? L("שלח", "Send") : L("המשך", "Continue")}</button>
      {!live && <button type="button" onClick={() => setOpen(false)}>{L("ביטול", "Cancel")}</button>}
    </form>
  );
}

/** The state's mark at the start of a row. */
function StateMark({ r }: { r: HelperRunInfo }) {
  if (r.state === "running") return <span className="hspin" aria-hidden />;
  if (r.state === "waiting") return <span className="warn" aria-hidden>⏳</span>;
  if (r.state === "asking") return <span className="ask" aria-hidden>?</span>;
  if (r.state === "done") return <span className="good" aria-hidden>✓</span>;
  if (r.state === "failed") return <span className="bad" aria-hidden>✕</span>;
  return <span className="muted" aria-hidden>■</span>;
}

/** The model chip, with why this model as its tooltip. */
function ModelChip({ r }: { r: HelperRunInfo }) {
  const note = getLocale() === "he" ? r.modelNoteHe ?? r.modelNote : r.modelNote;
  return <span className="hmodel" title={note}>{r.model}</span>;
}

/**
 * What a run used so far: tokens in and out, and how much of the prompt came from the cache (a run with no model call
 * yet, or an outside agent, shows nothing). KesherAI has no price list for cloud models, so it shows tokens only.
 */
function UsageChip({ r }: { r: HelperRunInfo }) {
  const u = r.usage;
  if (!u || u.calls === 0) return null;
  const est = u.estimated ? "~" : "";
  const pct = u.input > 0 && u.cached > 0 ? Math.round((u.cached / u.input) * 100) : undefined;
  const title = L(
    `${u.input} טוקנים נקראו, ${u.output} נכתבו${u.cached ? `, ${u.cached} מהם מהמטמון` : ""} · ${u.calls} קריאות למודל ${r.model}`,
    `${u.input} tokens read, ${u.output} written${u.cached ? `, ${u.cached} of them from the cache` : ""} · ${u.calls} calls to ${r.model}`,
  );
  return (
    <span className="husage small" dir="ltr" title={title}>
      <span className="tk-chip tk-io">↑{est}{kTokens(u.input)} ↓{est}{kTokens(u.output)}</span>
      {pct !== undefined && <span className={`tk-chip tk-cache${pct >= 50 ? " good" : ""}`} dir={getLocale() === "he" ? "rtl" : "ltr"}>{L("מטמון", "cache")} {pct}%</span>}
    </span>
  );
}

/** The swap row: the build agent's model coming in, running, and the lead agent's coming back. */
function SwapRow({ r, now }: { r: HelperRunInfo; now: number }) {
  const s = r.swap;
  if (!s) return null;
  if (s.phase === "done") return <div className="hswap done">↩ {L(`חזר ל-${s.from}`, `Back to ${s.from}`)}{s.backMs ? <> · {L("נטען ב-", "loaded in ")}<span className="mono">{clock(s.backMs)}</span></> : null}</div>;
  if (s.phase === "back") return <div className="hswap">↩ {L(`מחזיר את ${s.from}…`, `Loading ${s.from} back…`)}</div>;
  const t = elapsed(r, now);
  return (
    <div className="hswap">
      🔄 {s.phase === "loading" ? L(`מחליף מודל: ${s.from} → ${s.to}`, `Switching model: ${s.from} → ${s.to}`) : L(`מחליף מודל לעבודה הזו${s.sizeGiB ? ` (${s.sizeGiB} GB)` : ""}`, `Switched model for this job${s.sizeGiB ? ` (${s.sizeGiB} GB)` : ""}`)}
      {t !== undefined && <> · <span className="mono">{clock(t)}</span></>} · {L(`${s.from} חוזר בסוף`, `${s.from} comes back at the end`)}
    </div>
  );
}

/**
 * "Run this in Antigravity?" before a message to it: the same ask as the task inbox (also on the phone and through
 * the hub), one tap for one message, counted against the day's Antigravity limit.
 */
function RunAskRow({ r }: { r: HelperRunInfo }) {
  const ask = r.runAsk!;
  const answer = (decision: "allow" | "deny") => void api("/api/task-inbox/run-answer", { method: "POST", body: { requestId: ask.requestId, decision } }).catch((e) => toast((e as Error).message));
  const min = Math.max(0, Math.ceil((ask.until - Date.now()) / 60_000));
  return (
    <div className="hask hask-agy">
      <b>✦ {L("להריץ את זה ב-Antigravity?", "Run this in Antigravity?")}</b>
      <span className="hask-text">{ask.text}</span>
      <span className="small muted">{L(`נשארו היום: ${ask.left} · פג תוקף בעוד ${min} דק׳ · לחיצה אחת = הודעה אחת`, `Left today: ${ask.left} · expires in ${min} min · one tap = one message`)}</span>
      <div className="row">
        <button type="button" className="primary" onClick={() => answer("allow")}>▶ {L("הפעל", "Run")}</button>
        <button type="button" onClick={() => answer("deny")}>{L("לא עכשיו", "Not now")}</button>
      </div>
    </div>
  );
}

/** The card's question: may a cloud agent read this project's files (asked once per project). */
function AskRow({ r, convId }: { r: HelperRunInfo; convId: string }) {
  const answer = (yes: boolean) => void api(`/api/conversations/${convId}/helpers/${r.id}/answer`, { method: "POST", body: { yes } }).catch(() => undefined);
  return (
    <div className="hask">
      <span>☁ {L(`הסוכן רץ בענן (${r.model}). לתת לו לקרוא את קבצי הפרויקט הזה? נשאל פעם אחת לכל פרויקט.`, `This agent runs in the cloud (${r.model}). Let it read this project's files? Asked once per project.`)}</span>
      <div className="row">
        <button type="button" className="primary" onClick={() => answer(true)}>{L("כן, בפרויקט הזה", "Yes, in this project")}</button>
        <button type="button" onClick={() => answer(false)}>{L("רק השאלה, בלי קבצים", "The question only, no files")}</button>
      </div>
    </div>
  );
}

/** The run's steps (the last ones, or all), the current one marked. */
function Steps({ r, all }: { r: HelperRunInfo; all?: boolean }) {
  const list = all ? r.steps : r.steps.slice(-3);
  return (
    <div className="hsteps">
      {list.map((s, i) => {
        const st = stepText(s);
        if (st.note) return <span key={`${i}-${s}`} className="hstep-note">✎ {st.text}</span>;
        const current = r.state === "running" && i === list.length - 1;
        return <span key={`${i}-${s}`} className={current ? "acc" : ""}>{current ? "◌" : "✓"} {st.text}{current ? ` · ${L(`צעד ${r.step} מתוך ${r.maxSteps}`, `step ${r.step} of ${r.maxSteps}`)}` : ""}</span>;
      })}
      {!list.length && r.state === "running" && <span className="acc">◌ {L("מתחיל…", "Starting…")}</span>}
    </div>
  );
}

/** The report (cut ones open whole on "Show all"), a build's diff, or why it ended. */
function Report({ r, convId }: { r: HelperRunInfo; convId: string }) {
  const [full, setFull] = useState<string>();
  if (r.state === "failed") return <div className="hrep"><span className="bad">{r.error ?? L("נכשל", "Failed")}</span>{r.report ? <RichText text={r.report} /> : null}</div>;
  if (r.state === "stopped") return <div className="hrep muted">{L(`נעצר על ידך אחרי ${r.step} צעדים.`, `Stopped by you after ${r.step} steps.`)}</div>;
  if (r.state !== "done") return null;
  const files = r.diff ? (r.diff.match(/^diff --git /gm) ?? []).length : 0;
  return (
    <div className="hrep">
      <RichText text={full ?? r.report ?? L("(אין תשובה)", "(no answer)")} />
      {r.cut && !full && (
        <button type="button" className="link acc" onClick={() => void api<{ full?: string }>(`/api/conversations/${convId}/helpers/${r.id}`).then((x) => setFull(x.full ?? r.report ?? ""), () => undefined)}>{L("הצג הכול ›", "Show all ›")}</button>
      )}
      {r.diff !== undefined && (
        <details className="hdiff">
          <summary>{r.diff ? L(`השינויים בעותק שלו (${files} קבצים)`, `Its changes in its own copy (${files} files)`) : L("בלי שינויים", "No changes")}</summary>
          {r.diff && <pre dir="ltr">{r.diff}</pre>}
        </details>
      )}
    </div>
  );
}

/**
 * One sub-agent's card in the thread: type, task, model, state and time, Stop while it runs; its steps, the swap row,
 * the cloud question, and the short report when it ends.
 *
 * @param p.run - The run.
 * @param p.convId - The chat.
 */
export function HelperCard({ run: r, convId }: { run: HelperRunInfo; convId: string }) {
  const now = useNow(going(r));
  const [open, setOpen] = useState(false);
  const note = getLocale() === "he" ? r.modelNoteHe ?? r.modelNote : r.modelNote;
  return (
    <div className={`hcard ${going(r) && r.state !== "waiting" ? "live" : ""}`} id={`helper-${r.id}`}>
      <div className="hd">
        <StateMark r={r} />
        <span aria-hidden>{KINDS[r.kind].icon}</span>
        <b>{helperKindName(r)}</b>
        <span className="htitle" title={r.title}>{r.title}</span>
        {r.cloud && <span className="htag t-wait">☁ {r.cloudFiles === false ? L("ענן · רק שאלה, בלי קבצי הפרויקט", "cloud · the question only, no project files") : L("ענן", "cloud")}</span>}
        <ModelChip r={r} />
        <UsageChip r={r} />
        <ResumedTag r={r} />
        <ContinuedTag r={r} />
        <StateTag r={r} now={now} />
        {going(r) ? (
          <button type="button" className="hbtn" onClick={() => stop(convId, r.id)}>■ {L("עצור", "Stop")}</button>
        ) : r.steps.length > 0 ? (
          <button type="button" className="link muted small" aria-expanded={open} onClick={() => setOpen((o) => !o)}>{open ? L("הסתר צעדים", "Hide steps") : L("הצג צעדים ›", "Show steps ›")}</button>
        ) : null}
      </div>
      {note && (going(r) || open) && <div className="hnote muted small">{note}</div>}
      {r.state === "waiting" && r.restart === "paused" && <div className="hsteps warn">{L("KesherAI הופעל מחדש באמצע העבודה. הסוכן ימשיך לבד מהצעד שבו עצר כשהמודל מוכן.", "KesherAI restarted while it worked. It goes on by itself from the step where it stopped once the model is ready.")}</div>}
      {r.state === "waiting" && !r.restart && <div className="hsteps warn">{L(`ממתין לתור: עד ${r.waitLimit ?? 1} בבת אחת על כרטיס המסך הזה. יתחיל כשאחד יסתיים.`, `Waiting in the queue: up to ${r.waitLimit ?? 1} at once on this graphics card. Starts when one ends.`)}</div>}
      {r.state === "asking" && (r.runAsk ? <RunAskRow r={r} /> : <AskRow r={r} convId={convId} />)}
      {(r.state === "running" || open) && <Steps r={r} all={open} />}
      <SwapRow r={r} now={now} />
      <Report r={r} convId={convId} />
      <HelperTalk r={r} convId={convId} />
    </div>
  );
}

/**
 * The strip above the composer: the sub-agents that run or wait (a chip each: type, task, model, time, Stop), "Stop
 * all", and how many ended. A chip opens its run (the card on a computer, a bottom sheet on the phone). On the phone
 * it is one row that scrolls sideways.
 *
 * @param p.runs - The chat's runs.
 * @param p.convId - The chat.
 * @param p.onOpen - Opens a run.
 */
export function HelpersStrip({ runs, convId, onOpen }: { runs: HelperRunInfo[]; convId: string; onOpen: (r: HelperRunInfo) => void }) {
  const live = runs.filter(going);
  const now = useNow(live.length > 0);
  if (!live.length) return null;
  const running = live.filter((r) => r.state !== "waiting").length;
  const waiting = live.length - running;
  const done = runs.filter((r) => r.state === "done").length;
  return (
    <div className="hstrip" role="region" aria-label={L("סוכני משנה", "Sub-agents")}>
      <b className="small hstrip-title">{L("סוכני משנה", "Sub-agents")}</b>
      <span className="muted small hstrip-count">{L(`${running} רצים`, `${running} running`)}{waiting ? L(` · ${waiting} בתור`, ` · ${waiting} queued`) : ""}</span>
      <div className="hchips">
        {live.map((r) => {
          const t = elapsed(r, now);
          return (
            <div key={r.id} className={`hchip ${r.state === "waiting" ? "waiting" : ""}`}>
              <button type="button" className="hchip-open" onClick={() => onOpen(r)} title={r.usage ? `${r.title} · ↑${kTokens(r.usage.input)} ↓${kTokens(r.usage.output)}` : r.title}>
                <StateMark r={r} />
                <span aria-hidden>{KINDS[r.kind].icon}</span>
                <span className="hchip-name">{helperKindName(r)}<span className="hchip-task">: {r.title}</span></span>
                <span className="hmodel">{r.model}</span>
                {r.state === "waiting" && r.restart === "paused" ? <span className="warn small">{L("הושהה", "paused")}</span> : r.state === "waiting" ? <span className="warn small">{L("בתור", "queued")}</span> : r.state === "asking" ? <span className="ask small">{L("שואל", "asking")}</span> : <span className="mono muted">{t === undefined ? "" : clock(t)}</span>}
              </button>
              <button type="button" className="hx" aria-label={L("עצור", "Stop")} title={L("עצור", "Stop")} onClick={() => stop(convId, r.id)}>■</button>
            </div>
          );
        })}
        {done > 0 && <span className="hdone small good">✓ {done}</span>}
      </div>
      {live.length > 1 && (
        <button type="button" className="hbtn bad hstop-all" onClick={() => void api(`/api/conversations/${convId}/helpers/stop`, { method: "POST" }).catch(() => undefined)}>■ {L("עצור הכול", "Stop all")}</button>
      )}
    </div>
  );
}

/**
 * One run as a bottom sheet (the phone): its task, model and why, the step count and the time cap, every step, and
 * "Show in chat" / Stop.
 *
 * @param p.run - The run (kept fresh by the caller).
 * @param p.convId - The chat.
 * @param p.onClose - Closes the sheet.
 */
export function HelperSheet({ run: r, convId, onClose }: { run: HelperRunInfo; convId: string; onClose: () => void }) {
  const now = useNow(going(r));
  const note = getLocale() === "he" ? r.modelNoteHe ?? r.modelNote : r.modelNote;
  return (
    <div className="hsheet-wrap" onClick={onClose}>
      <div className="hsheet" role="dialog" aria-modal="true" aria-label={`${helperKindName(r)}: ${r.title}`} onClick={(e) => e.stopPropagation()}>
        <div className="hsheet-handle" aria-hidden />
        <div className="hd">
          <StateMark r={r} />
          <span aria-hidden>{KINDS[r.kind].icon}</span>
          <b>{helperKindName(r)}</b>
          <span className="grow" />
          <ResumedTag r={r} />
          <ContinuedTag r={r} />
          <StateTag r={r} now={now} />
        </div>
        <div className="hsheet-task">{r.title}</div>
        <div className="row small"><ModelChip r={r} /><UsageChip r={r} />{note && <span className="muted">{note}</span>}</div>
        <div className="hprog small">
          <span>{L(`צעד ${r.step} מתוך ${r.maxSteps}`, `Step ${r.step} of ${r.maxSteps}`)}</span>
          <div className="hbar"><b style={{ width: `${Math.min(100, (r.step / Math.max(1, r.maxSteps)) * 100)}%` }} /></div>
        </div>
        {r.state === "asking" && (r.runAsk ? <RunAskRow r={r} /> : <AskRow r={r} convId={convId} />)}
        <SwapRow r={r} now={now} />
        <b className="small">{L("צעדים", "Steps")}</b>
        <Steps r={r} all />
        <Report r={r} convId={convId} />
        <HelperTalk r={r} convId={convId} />
        <div className="row hsheet-actions">
          <button type="button" onClick={() => { onClose(); setTimeout(() => document.getElementById(`helper-${r.id}`)?.scrollIntoView({ block: "center", behavior: "smooth" }), 50); }}>{L("הצג בצ׳אט", "Show in chat")}</button>
          {going(r) && <button type="button" className="bad" onClick={() => stop(convId, r.id)}>■ {L("עצור את הסוכן", "Stop the agent")}</button>}
        </div>
      </div>
    </div>
  );
}

/**
 * The notice while a build agent's model is loaded instead of the lead agent's (board HelperModelSwap): why it was
 * loaded, that the lead's model comes back, the load's progress, and Cancel (stops that agent).
 *
 * @param p.runs - The chat's runs.
 * @param p.convId - The chat.
 */
export function HelperSwapNotice({ runs, convId }: { runs: HelperRunInfo[]; convId: string }) {
  const r = runs.find((x) => x.swap && (x.swap.phase === "loading" || x.swap.phase === "back") && going(x));
  const now = useNow(!!r);
  if (!r?.swap) return null;
  const s = r.swap;
  const t = elapsed(r, now) ?? 0;
  const guess = Math.max(5, Math.round((s.sizeGiB ?? 8) * 2.4)) * 1000;
  return (
    <div className="hswap-notice" role="status">
      <span className="hswap-icon" aria-hidden>🔄</span>
      <div className="grow">
        <b>{s.phase === "back" ? L(`${s.from} חוזר אחרי סוכן ה${KINDS[r.kind].he}`, `${s.from} is coming back after the ${KINDS[r.kind].en.toLowerCase()} agent`) : L(`נטען כי: סוכן ${KINDS[r.kind].he} "${r.title}" צריך ${s.to}`, `Loaded because: a ${KINDS[r.kind].en.toLowerCase()} agent "${r.title}" needs ${s.to}`)}</b>
        <div className="muted small">{L(`${s.from} ירד מהכרטיס (שניהם יחד לא נכנסים). החלפה אחת לעבודה, ו-${s.from} חוזר בסוף. בזמן הזה הצ׳אט מחכה.`, `${s.from} left the card (both do not fit together). One swap for the job, and ${s.from} comes back at the end. The chat waits meanwhile.`)}</div>
      </div>
      {s.phase === "loading" && (
        <div className="hswap-prog small">
          <div className="hbar"><b style={{ width: `${Math.min(95, (t / guess) * 100)}%` }} /></div>
          <span className="mono">{clock(t)} / ~{clock(guess)}</span>
        </div>
      )}
      {s.phase === "loading" && <button type="button" onClick={() => stop(convId, r.id)}>{L("ביטול", "Cancel")}</button>}
    </div>
  );
}

import { useEffect, useState } from "react";
import { agentDoing, parseDiff, stepTool, type AgentLabel, type DiffFile, type HelperRunInfo, type LabelWords } from "@kesher/shared";
import { AgentLabelEditor, AgentLabelLines, words } from "./AgentLabel";
import { api } from "./api";
import { getLocale, he$ } from "./i18n";
import { RichText } from "./RichText";
import { toast } from "./library";
import { kTokens } from "./chat-status";
import { plansOf } from "./plan-view";

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
  operate: { icon: "🖱️", he: "הפעלה", en: "Operator" },
  external: { icon: "🛰️", he: "חיצוני", en: "Outside" },
};

/** @returns The type's icon ("📚"). */
export const helperKindIcon = (kind: HelperRunInfo["kind"]): string => (KINDS[kind] ?? KINDS.research).icon;

/** @returns The type's short name ("מחקר"), or the named agent's. */
export function helperKindName(r: Pick<HelperRunInfo, "kind" | "agent">): string {
  return r.agent ? `@${r.agent}` : L(KINDS[r.kind].he, KINDS[r.kind].en);
}

/** The role as a sub-agent's name on an approval card: "סוכן מחקר", "research agent" (a named agent: "@name"). */
const AGENT_WORD: Record<HelperRunInfo["kind"], [string, string]> = {
  lookup: ["סוכן חיפוש", "lookup agent"],
  research: ["סוכן מחקר", "research agent"],
  build: ["סוכן בנייה", "build agent"],
  operate: ["סוכן הפעלה", "operator agent"],
  external: ["סוכן חיצוני", "outside agent"],
};

/**
 * @returns The icon and the role of a sub-agent that asks for approval ("סוכן מחקר", "research agent", or "@name").
 * @param h - Who asks.
 */
export function helperAskerName(h: Pick<HelperRunInfo, "kind" | "agent">): { icon: string; role: string } {
  const w = AGENT_WORD[h.kind] ?? AGENT_WORD.research;
  return { icon: (KINDS[h.kind] ?? KINDS.research).icon, role: h.agent ? `@${h.agent}` : L(w[0], w[1]) };
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
export function useNow(active: boolean): number {
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

/**
 * Saves the owner's name and note for a run (empty fields clear them).
 *
 * @param convId - The chat.
 * @param id - The run.
 * @param label - The name and note.
 */
export const saveLabel = (convId: string, id: string, label: AgentLabel) => api(`/api/conversations/${convId}/helpers/${id}/label`, { method: "PUT", body: label });

/** The run's own "doing now" line, from its state and latest step (none once it ended). */
export const helperDoing = (r: HelperRunInfo): LabelWords | undefined => agentDoing({ state: r.state === "waiting" ? "queued" : r.state, ...stepTool(r.steps.at(-1)) });

/** The run's shown name: the owner's, or its task. */
export const helperName = (r: HelperRunInfo): string => r.name || r.title;

export const stop = (convId: string, id: string) => void api(`/api/conversations/${convId}/helpers/${id}/stop`, { method: "POST" }).catch(() => undefined);

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
export function StateMark({ r }: { r: HelperRunInfo }) {
  if (r.state === "running") return <span className="hspin" aria-hidden />;
  if (r.state === "waiting") return <span className="warn" aria-hidden>⏳</span>;
  if (r.state === "asking") return <span className="ask" aria-hidden>?</span>;
  if (r.state === "done") return <span className="good" aria-hidden>✓</span>;
  if (r.state === "failed") return <span className="bad" aria-hidden>✕</span>;
  return <span className="muted" aria-hidden>■</span>;
}

/** The model chip, with why this model as its tooltip. */
export function ModelChip({ r }: { r: HelperRunInfo }) {
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
          {r.diff && (r.kind === "build" ? <DiffReview r={r} convId={convId} /> : <pre dir="ltr">{r.diff}</pre>)}
        </details>
      )}
    </div>
  );
}

/** A hunk's mark on the card. */
const DECIDED = { accepted: ["✓ נשמר", "✓ Kept"], rejected: ["✕ נדחה", "✕ Rejected"] } as const;

/**
 * A build sub-agent's changes for review (chat step 9b; as Cursor's Accept / Reject per change): a card per file with
 * each hunk's Accept / Reject, the file's Accept all / Reject all, and the same for every file at the top. The server
 * applies accepted hunks to the project only where the file still matches, and tells the lead agent; conflicts show
 * under the hunk. Decisions come back on the run, so the phone in remote shows the same.
 */
export function DiffReview({ r, convId }: { r: HelperRunInfo; convId: string }) {
  const [busy, setBusy] = useState(false);
  const [conflicts, setConflicts] = useState<Record<string, string>>({});
  const files = parseDiff(r.diff ?? "");
  const review = r.review ?? {};
  const open = (f: DiffFile) => f.hunks.some((_, i) => !review[f.path]?.[i]);
  const send = async (decision: "accepted" | "rejected", path?: string, hunk?: number) => {
    setBusy(true);
    try {
      const out = await api<{ conflicts: Array<{ path: string; hunk: number; reason: string }> }>(`/api/conversations/${convId}/helpers/${r.id}/review`, { method: "POST", body: { decision, ...(path !== undefined ? { path } : {}), ...(hunk !== undefined ? { hunks: [hunk] } : {}) } });
      setConflicts((c) => ({ ...c, ...Object.fromEntries(out.conflicts.map((x) => [`${x.path}#${x.hunk}`, x.reason])) }));
      if (out.conflicts.length) toast(L(`${out.conflicts.length} שינויים לא הוחלו: הקובץ השתנה מאז`, `${out.conflicts.length} changes were not applied: the file changed since`));
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const Buttons = ({ path, hunk, all }: { path?: string; hunk?: number; all?: boolean }) => (
    <span className="hrev-btns">
      <button type="button" className="small primary" disabled={busy} onClick={() => void send("accepted", path, hunk)}>{all ? L("אישור הכול", "Accept all") : L("אישור", "Accept")}</button>
      <button type="button" className="small" disabled={busy} onClick={() => void send("rejected", path, hunk)}>{all ? L("דחיית הכול", "Reject all") : L("דחייה", "Reject")}</button>
    </span>
  );
  return (
    <div className="hrev">
      {files.some(open) && files.length > 1 && (
        <div className="hrev-top">
          <span className="muted small">{L("כל הקבצים:", "Every file:")}</span>
          <Buttons all />
        </div>
      )}
      {files.map((f) => (
        <div key={f.path} className="hrev-file">
          <div className="hrev-head">
            <code className="hrev-path" dir="ltr" title={f.path}>{f.path}</code>
            {f.kind !== "modify" && <span className="muted small">{f.kind === "add" ? L("חדש", "new") : f.kind === "delete" ? L("נמחק", "deleted") : L("בינארי", "binary")}</span>}
            {open(f) && f.hunks.length > 1 && <Buttons path={f.path} all />}
          </div>
          {f.hunks.map((h, i) => {
            const d = review[f.path]?.[i];
            const why = conflicts[`${f.path}#${i}`];
            return (
              <div key={i} className={`hrev-hunk${d ? ` ${d}` : ""}`}>
                <pre className="code diff" dir="ltr">
                  <span className="hunk">{h.header}{"\n"}</span>
                  {h.lines.map((l, j) => <span key={j} className={l[0] === "+" ? "add" : l[0] === "-" ? "del" : ""}>{l}{"\n"}</span>)}
                </pre>
                <div className="hrev-row">
                  {d ? <span className={`small ${d === "accepted" ? "ok" : "muted"}`}>{L(DECIDED[d][0], DECIDED[d][1])}</span> : <Buttons path={f.path} hunk={i} />}
                  {why && !d && <span className="bad small" dir="auto">{L("לא הוחל: הקובץ השתנה מאז שהסוכן קרא אותו.", "Not applied: the file changed since the agent read it.")}</span>}
                </div>
              </div>
            );
          })}
          {f.cut && <p className="muted small">{L("השינויים בקובץ הזה ארוכים מדי להצגה כאן; השאר לא מוצג ולא יוחל.", "This file's changes are too long to show here; the rest is not shown and is not applied.")}</p>}
        </div>
      ))}
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
  const [editing, setEditing] = useState(false);
  const note = getLocale() === "he" ? r.modelNoteHe ?? r.modelNote : r.modelNote;
  return (
    <div className={`hcard ${going(r) && r.state !== "waiting" ? "live" : ""}`} id={`helper-${r.id}`}>
      <div className="hd">
        <StateMark r={r} />
        <span aria-hidden>{KINDS[r.kind].icon}</span>
        <b>{helperKindName(r)}</b>
        <span className={`htitle${r.name ? " named" : ""}`} title={r.title} dir="auto">{helperName(r)}</span>
        {r.cloud && <span className="htag t-wait">☁ {r.cloudFiles === false ? L("ענן · רק שאלה, בלי קבצי הפרויקט", "cloud · the question only, no project files") : L("ענן", "cloud")}</span>}
        <ModelChip r={r} />
        <UsageChip r={r} />
        <ResumedTag r={r} />
        <ContinuedTag r={r} />
        <StateTag r={r} now={now} />
        <button type="button" className="hbtn" aria-expanded={editing} aria-label={L("שם והערה לסוכן", "The agent's name and note")} title={L("שם והערה", "Name and note")} onClick={() => setEditing((e) => !e)}>✎ <span className="hbtn-t">{r.name || r.note ? L("ערוך", "Edit") : L("שם והערה", "Name & note")}</span></button>
        {going(r) ? (
          <button type="button" className="hbtn" onClick={() => stop(convId, r.id)}>■ {L("עצור", "Stop")}</button>
        ) : r.steps.length > 0 ? (
          <button type="button" className="link muted small" aria-expanded={open} onClick={() => setOpen((o) => !o)}>{open ? L("הסתר צעדים", "Hide steps") : L("הצג צעדים ›", "Show steps ›")}</button>
        ) : null}
      </div>
      {note && (going(r) || open) && <div className="hnote muted small">{note}</div>}
      <AgentLabelLines title={r.title} name={r.name} note={r.note} doing={r.state === "running" ? helperDoing(r) : undefined} />
      {editing && <AgentLabelEditor title={r.title} label={{ name: r.name, note: r.note }} save={(l) => saveLabel(convId, r.id, l)} onClose={() => setEditing(false)} />}
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
  // A plan's sub-agents show as one chip (its card or sheet lists them).
  const plans = plansOf(runs).filter((v) => v.going > 0);
  return (
    <div className="hstrip" role="region" aria-label={L("סוכני משנה", "Sub-agents")}>
      <b className="small hstrip-title">{L("סוכני משנה", "Sub-agents")}</b>
      <span className="muted small hstrip-count">{L(`${running} רצים`, `${running} running`)}{waiting ? L(` · ${waiting} בתור`, ` · ${waiting} queued`) : ""}</span>
      <div className="hchips">
        {plans.map((v) => (
          <div key={v.plan.id} className="hchip hchip-plan">
            <button type="button" className="hchip-open" onClick={() => onOpen(v.runs.find(going) ?? v.runs[0]!)} title={v.plan.goal}>
              <span className="hspin" aria-hidden />
              <span aria-hidden>{v.plan.kind === "research" ? "🔬" : "🗺️"}</span>
              <span className="hchip-name">{v.plan.kind === "research" ? L("מחקר מעמיק", "Deep research") : L("תוכנית", "Plan")}<span className="hchip-task">: {v.plan.goal}</span></span>
              <span className="mono muted">{v.done}/{v.runs.filter((r) => !r.removed).length}</span>
            </button>
          </div>
        ))}
        {live.filter((r) => !r.plan).map((r) => {
          const t = elapsed(r, now);
          return (
            <div key={r.id} className={`hchip ${r.state === "waiting" ? "waiting" : ""}`}>
              <button type="button" className="hchip-open" onClick={() => onOpen(r)} title={[r.name, r.title, r.note, r.usage ? `↑${kTokens(r.usage.input)} ↓${kTokens(r.usage.output)}` : ""].filter(Boolean).join(" · ")}>
                <StateMark r={r} />
                <span aria-hidden>{KINDS[r.kind].icon}</span>
                <span className="hchip-name">{r.name || helperKindName(r)}<span className="hchip-task">: {r.name ? words(helperDoing(r)) || r.title : r.title}</span></span>
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
  const [editing, setEditing] = useState(false);
  const note = getLocale() === "he" ? r.modelNoteHe ?? r.modelNote : r.modelNote;
  return (
    <div className="hsheet-wrap" onClick={onClose}>
      <div className="hsheet" role="dialog" aria-modal="true" aria-label={`${helperKindName(r)}: ${helperName(r)}`} onClick={(e) => e.stopPropagation()}>
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
        <div className="row">
          <div className="hsheet-task grow" dir="auto">{helperName(r)}</div>
          <button type="button" className="hbtn" aria-expanded={editing} onClick={() => setEditing((e) => !e)}>✎ {r.name || r.note ? L("ערוך", "Edit") : L("שם והערה", "Name & note")}</button>
        </div>
        <AgentLabelLines title={r.title} name={r.name} note={r.note} doing={r.state === "running" ? helperDoing(r) : undefined} />
        {editing && <AgentLabelEditor title={r.title} label={{ name: r.name, note: r.note }} save={(l) => saveLabel(convId, r.id, l)} onClose={() => setEditing(false)} />}
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

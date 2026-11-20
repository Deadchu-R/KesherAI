import { useState } from "react";
import type { HelperRunInfo } from "@kesher/shared";
import { getLocale, he$ } from "./i18n";
import { ItemCard } from "./DocPanel";
import { clock, going, HelperCard, helperKindIcon, helperKindName, ModelChip, StateMark, stop, useNow } from "./Helpers";
import { planCollapsed, type PlanView } from "./plan-view";

/**
 * The Plan card (docs/RESEARCH_LOG.md, "Gap list: agents and chat-first", A15 and A16; design boards PlanCard and
 * PhonePlanSheet): when the lead agent splits one job among two or more sub-agents, or runs a deep research, the
 * chat shows one card: the goal, each sub-agent's task, role, model and state, live; the lead's revisions (added or
 * removed sub-agents, a new goal) show as they come. When all have ended it folds to one summary line. A deep
 * research also shows its stage (researching, writing the report) and, at the end, the report's document card,
 * which opens beside the chat. Everything comes from the chat's `helpers` events, so the phone shows the same.
 */

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);

/** The state of one row, in words. */
function rowState(r: HelperRunInfo): string {
  if (r.removed) return L("הוסר מהתוכנית", "removed");
  return { waiting: L("בתור", "queued"), asking: L("מחכה לך", "waiting for you"), running: L("עובד", "running"), done: L("הסתיים", "done"), failed: L("נכשל", "failed"), stopped: L("נעצר", "stopped") }[r.state];
}

/** The plan's stage, in words (and a deep research's step). */
function stageText(v: PlanView): string {
  const research = v.plan.kind === "research";
  switch (v.stage) {
    case "running":
      return research ? L(`חוקר ${v.runs.filter((r) => !r.removed).length} שאלות משנה במקביל…`, `Researching ${v.runs.filter((r) => !r.removed).length} sub-questions at once…`) : L(`${v.going} עובדים`, `${v.going} working`);
    case "writing":
      return L("הסוכן הראשי כותב את הדוח…", "The lead agent is writing the report…");
    case "done":
      return research ? L("הדוח מוכן", "Report ready") : L("הסתיים", "Done");
    case "failed":
      return L("נכשל", "Failed");
    default:
      return L("נעצר", "Stopped");
  }
}

/** The one-line summary of an ended plan: done / failed / stopped counts and how long it took. */
function summary(v: PlanView): string {
  const parts = [L(`${v.done} הסתיימו`, `${v.done} done`)];
  if (v.failed) parts.push(L(`${v.failed} נכשלו`, `${v.failed} failed`));
  if (v.stopped) parts.push(L(`${v.stopped} נעצרו`, `${v.stopped} stopped`));
  if (v.startedAt && v.endedAt) parts.push(clock(v.endedAt - v.startedAt));
  return parts.join(" · ");
}

/** The sub-agents' rows; a tap opens one (its card inline, or the phone's sheet through `onOpen`). */
function PlanRows({ v, convId, onOpen }: { v: PlanView; convId: string; onOpen?: (r: HelperRunInfo) => void }) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <ol className="plan-rows">
      {v.runs.map((r) => (
        <li key={r.id} className={r.removed ? "removed" : ""}>
          <button type="button" className="plan-row" aria-expanded={!onOpen ? open === r.id : undefined} onClick={() => (onOpen ? onOpen(r) : setOpen((o) => (o === r.id ? null : r.id)))}>
            <StateMark r={r} />
            <span aria-hidden>{helperKindIcon(r.kind)}</span>
            <b className="plan-role">{helperKindName(r)}</b>
            <span className="plan-task" dir="auto" title={r.title}>{r.title}</span>
            <ModelChip r={r} />
            <span className={`plan-state small ${r.state === "failed" ? "bad" : r.state === "done" ? "good" : "muted"}`}>{rowState(r)}</span>
          </button>
          {!onOpen && open === r.id && <HelperCard run={r} convId={convId} />}
        </li>
      ))}
    </ol>
  );
}

/** The research report's card, opened beside the chat (DocPanel). */
function ReportDoc({ v, convId, live = false }: { v: PlanView; convId: string; live?: boolean }) {
  const d = v.plan.doc;
  if (!d) return null;
  // `live`: it just came while the chat works, so it opens beside the chat by itself on a wide screen.
  return <ItemCard item={{ kind: "doc", id: d.id, convId, title: d.title }} {...(d.ver ? { ver: d.ver } : {})} live={live} />;
}

/**
 * One plan's card in the thread (after the call that started it).
 *
 * @param p.view - The plan (plan-view.ts).
 * @param p.convId - The chat.
 * @param p.busy - The chat is working now (a report that comes meanwhile opens beside the chat).
 */
export function PlanCard({ view: v, convId, busy = false }: { view: PlanView; convId: string; busy?: boolean }) {
  const live = !planCollapsed(v);
  const now = useNow(live);
  const [open, setOpen] = useState<boolean | null>(null);
  const shown = open ?? live;
  const research = v.plan.kind === "research";
  const title = research ? L("מחקר מעמיק", "Deep research") : L("תוכנית", "Plan");
  const on = v.runs.filter((r) => !r.removed).length;
  return (
    <div className={`hcard plan-card ${live ? "live" : ""}`} id={`plan-${v.plan.id}`}>
      <div className="hd">
        {live ? <span className="hspin" aria-hidden /> : <span className={v.stage === "done" ? "good" : v.stage === "failed" ? "bad" : "muted"} aria-hidden>{v.stage === "done" ? "✓" : v.stage === "failed" ? "✕" : "■"}</span>}
        <span aria-hidden>{research ? "🔬" : "🗺️"}</span>
        <b>{title}</b>
        <span className="htitle" dir="auto" title={v.plan.goal}>{v.plan.goal}</span>
        {!!v.plan.rev && <span className="htag t-run" title={L("הסוכן הראשי שינה את התוכנית", "The lead agent revised the plan")}>✎ {L(`עודכנה ×${v.plan.rev}`, `revised ×${v.plan.rev}`)}</span>}
        <span className="mono muted small">{v.done}/{on}{live && v.startedAt ? ` · ${clock(now - v.startedAt)}` : ""}</span>
        {v.going > 0 && <button type="button" className="hbtn" onClick={() => v.runs.filter(going).forEach((r) => stop(convId, r.id))}>■ {L("עצור הכול", "Stop all")}</button>}
        <button type="button" className="link muted small" aria-expanded={shown} onClick={() => setOpen(!shown)}>{shown ? L("הסתר", "Hide") : L("פרטים ›", "Details ›")}</button>
      </div>
      {shown ? (
        <>
          <div className={`plan-stage small ${v.stage === "failed" ? "bad" : "muted"}`}>{stageText(v)}</div>
          <PlanRows v={v} convId={convId} />
        </>
      ) : (
        <div className="plan-summary small muted">{stageText(v)} · {summary(v)}</div>
      )}
      <ReportDoc v={v} convId={convId} live={busy} />
    </div>
  );
}

/**
 * A plan as a bottom sheet (the phone, from the sub-agents strip): the goal, the stage, every sub-agent (a tap opens
 * its own sheet), the report when ready, and Stop all.
 *
 * @param p.view - The plan.
 * @param p.convId - The chat.
 * @param p.onOpen - Opens one sub-agent's sheet.
 * @param p.onClose - Closes the sheet.
 */
export function PlanSheet({ view: v, convId, onOpen, onClose }: { view: PlanView; convId: string; onOpen: (r: HelperRunInfo) => void; onClose: () => void }) {
  const research = v.plan.kind === "research";
  return (
    <div className="hsheet-wrap" onClick={onClose}>
      <div className="hsheet" role="dialog" aria-modal="true" aria-label={`${research ? L("מחקר מעמיק", "Deep research") : L("תוכנית", "Plan")}: ${v.plan.goal}`} onClick={(e) => e.stopPropagation()}>
        <div className="hsheet-handle" aria-hidden />
        <div className="hd">
          <span aria-hidden>{research ? "🔬" : "🗺️"}</span>
          <b>{research ? L("מחקר מעמיק", "Deep research") : L("תוכנית", "Plan")}</b>
          <span className="grow" />
          {!!v.plan.rev && <span className="htag t-run">✎ {L(`עודכנה ×${v.plan.rev}`, `revised ×${v.plan.rev}`)}</span>}
          <span className="mono muted small">{v.done}/{v.runs.filter((r) => !r.removed).length}</span>
        </div>
        <div className="hsheet-task" dir="auto">{v.plan.goal}</div>
        <div className={`plan-stage small ${v.stage === "failed" ? "bad" : "muted"}`}>{stageText(v)}{planCollapsed(v) ? ` · ${summary(v)}` : ""}</div>
        <PlanRows v={v} convId={convId} onOpen={onOpen} />
        <ReportDoc v={v} convId={convId} />
        <div className="row hsheet-actions">
          <button type="button" onClick={() => { onClose(); setTimeout(() => document.getElementById(`plan-${v.plan.id}`)?.scrollIntoView({ block: "center", behavior: "smooth" }), 50); }}>{L("הצג בצ׳אט", "Show in chat")}</button>
          {v.going > 0 && <button type="button" className="bad" onClick={() => v.runs.filter(going).forEach((r) => stop(convId, r.id))}>■ {L("עצור הכול", "Stop all")}</button>}
        </div>
      </div>
    </div>
  );
}

/** The chat's header tools: an agent group, a planner/reviewer team, and saving the chat as a file. */
import { useEffect, useRef, useState } from "react";
import type { ModelInfo, Teammate } from "@kesher/shared";
import { api, withToken } from "../api";
import { getLocale, t } from "../i18n";
import { desktop, toast } from "../library";
import { ModelMenu } from "../ModelMenu";
import { usePersonas } from "../Personas";
import { Menu, MenuItem, MenuLabel } from "../ui/Menu";
import { LineIcon } from "../ui/Glyph";
import { clockText } from "./clock-text";

/**
 * Agent group: personas this chat's model leads. It splits a request between
 * them (each answers with its own instructions and model) and puts it together.
 */
export function GroupButton({ group, onChange }: { group: string[]; onChange: (group: string[]) => void }) {
  const personas = usePersonas();
  const [open, setOpen] = useState(false);
  const he = getLocale() === "he";
  const toggle = (id: string) => onChange(group.includes(id) ? group.filter((x) => x !== id) : [...group, id].slice(0, 8));
  return (
    <div className="team">
      <button type="button" className={group.length ? "on" : ""} aria-expanded={open} onClick={() => setOpen(!open)} title={he ? "קבוצת סוכנים: כמה פרסונות עובדות יחד על משימה" : "Agent group: several personas work on one task together"}>
        {he ? "קבוצה" : "Group"}{group.length ? ` (${group.length})` : ""}
      </button>
      {open && (
        <div className="team-pop" role="dialog" aria-label={he ? "קבוצה" : "Group"}>
          <p className="muted small">{he ? "המודל של הצ'אט מוביל את הקבוצה: הוא מחלק את הבקשה בין החברים, כל אחד עונה עם ההוראות והמודל שלו, והוא מאחד את התשובות." : "The chat's model leads the group: it splits the request between the members, each answers with its own instructions and model, and it puts their work together."}</p>
          {personas.length === 0 && <p className="small">{he ? "אין עדיין פרסונות. " : "No personas yet. "}<a href="#/personas">{he ? "צור פרסונה" : "Make one"}</a></p>}
          {personas.map((p) => (
            <label key={p.id} className="row" style={{ gap: 8 }}>
              <input type="checkbox" checked={group.includes(p.id)} onChange={() => toggle(p.id)} />
              <span>{p.icon ?? "👤"} {p.name}</span>
              {p.modelId && <span className="muted small" dir="ltr">{p.modelId.split("/").pop()}</span>}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Multi-model chat: pick a planner (writes a plan before each request) and a
 * reviewer (checks the answer and sends it back with notes) next to the
 * main model. Any connected model can take either job.
 */
export function TeamButton({ team, models, onChange }: { team: Teammate[]; models: ModelInfo[]; onChange: (team: Teammate[]) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !ref.current?.contains(e.target as Node) && !(e.target as Element).closest?.(".model-pop")) setOpen(false);
    };
    addEventListener("mousedown", close);
    addEventListener("keydown", close);
    return () => {
      removeEventListener("mousedown", close);
      removeEventListener("keydown", close);
    };
  }, [open]);
  const of = (role: Teammate["role"]) => team.find((m) => m.role === role)?.modelId ?? "";
  const set = (role: Teammate["role"], modelId: string) => onChange([...team.filter((m) => m.role !== role), ...(modelId ? [{ role, modelId }] : [])]);
  return (
    <div className="team" ref={ref}>
      <button type="button" className={team.length ? "on" : ""} aria-expanded={open} onClick={() => setOpen(!open)} title={t("teamHint")}>
        {t("team")}{team.length ? ` (${team.length + 1})` : ""}
      </button>
      {open && (
        <div className="team-pop" role="dialog" aria-label={t("team")}>
          <p className="muted small">{t("teamHint")}</p>
          {(["planner", "reviewer"] as const).map((role) => (
            <div key={role} className="team-row">
              <div>
                <strong>{role === "planner" ? t("rolePlanner") : t("roleReviewer")}</strong>
                <p className="muted small">{role === "planner" ? t("plannerHint") : t("reviewerHint")}</p>
              </div>
              <div className="row">
                {of(role) ? (
                  <>
                    <ModelMenu models={models} value={of(role)} onChange={(id) => set(role, id)} />
                    <button type="button" className="link-btn" onClick={() => set(role, "")}>{t("remove")}</button>
                  </>
                ) : (
                  <button type="button" onClick={() => models[0] && set(role, models[0].id)} disabled={!models.length}>{t("addTeammate")}</button>
                )}
              </div>
            </div>
          ))}
          <p className="muted small">{t("teamCost")}</p>
        </div>
      )}
    </div>
  );
}

/**
 * Saves the chat as a file: Markdown (downloaded), or PDF (the desktop app
 * asks where to save it; a browser opens the print dialog: "Save as PDF").
 */
export function exportChat(id: string, kind: "md" | "pdf"): void {
  if (kind === "pdf" && desktop()?.saveChatPdf) {
    void desktop()!.saveChatPdf!(id).then((file) => file && toast(getLocale() === "he" ? `נשמר: ${file}` : `Saved: ${file}`), (e: Error) => toast(e.message));
    return;
  }
  const url = withToken(`/api/conversations/${id}/export?${kind === "md" ? "format=md&download=1" : "format=html&print=1"}`);
  if (kind === "pdf") {
    window.open(url, "_blank", "noopener");
    return;
  }
  const a = document.createElement("a");
  a.href = url;
  a.download = "";
  document.body.append(a);
  a.click();
  a.remove();
}

/** A timer the model set in this chat (chat-timers.ts). */
interface WaitingTimer { id: string; prompt: string; due: number; kind?: "checkback" }

/**
 * The model's waiting timers in this chat ("check the build in an hour"), shown only when there are some: a clock
 * with the count, and a list where each can be cancelled (Open WebUI keeps them hidden; here they are visible).
 *
 * @param props.convId - The chat.
 */
export function TimersButton({ convId }: { convId: string }) {
  const [timers, setTimers] = useState<WaitingTimer[]>([]);
  const he = getLocale() === "he";
  useEffect(() => {
    const load = () => !document.hidden && void api<{ timers: WaitingTimer[] }>(`/api/timers?conv=${encodeURIComponent(convId)}`).then((r) => setTimers(r.timers), () => undefined);
    load();
    const t = window.setInterval(load, 30_000);
    addEventListener("focus", load);
    return () => (window.clearInterval(t), removeEventListener("focus", load));
  }, [convId]);
  if (!timers.length) return null;
  const when = (due: number) => {
    const min = Math.round((due - Date.now()) / 60_000);
    if (min < 1) return he ? "עכשיו" : "now";
    if (min < 120) return he ? `בעוד ${min} דק'` : `in ${min} min`;
    return new Date(due).toLocaleString(he ? "he-IL" : undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" });
  };
  const cancel = (id: string) =>
    void api(`/api/timers/${encodeURIComponent(id)}`, { method: "DELETE" }).then(
      () => setTimers((x) => x.filter((y) => y.id !== id)),
      (e: Error) => toast(e.message),
    );
  // The soonest check_back_later: "⏰ checks back at 19:40 · Cancel" (the label is hidden on a phone, the time and Cancel stay).
  const next = timers.find((x) => x.kind === "checkback");
  const chip = next && (
    <span className="checkback-chip" title={next.prompt} dir="auto">
      <span aria-hidden>⏰</span>
      <span className="checkback-label">{he ? "חוזר לבדוק ב-" : "checks back at "}</span>
      <b>{new Date(next.due).toLocaleTimeString(he ? "he-IL" : undefined, { hour: "2-digit", minute: "2-digit" })}</b>
      <button type="button" className="checkback-cancel" onClick={() => cancel(next.id)} aria-label={he ? "ביטול הבדיקה החוזרת" : "Cancel the check-back"}>
        · {he ? "ביטול" : "Cancel"}
      </button>
    </span>
  );
  return (
    <>
    {chip}
    <Menu
      trigger={<><LineIcon name="bell" size={16} /> {timers.length}</>}
      triggerClassName="pane-btn"
      title={he ? "תזכורות שהמודל קבע בצ'אט הזה" : "Timers the model set in this chat"}
      aria-label={he ? "תזכורות" : "Timers"}
      popClassName="bar-pop"
    >
      <MenuLabel>{he ? "הצ'אט יחזור לעבוד בזמנים האלה" : "This chat comes back at these times"}</MenuLabel>
      {timers.map((x) => (
        <MenuItem key={x.id} keepOpen icon={<LineIcon name="close" size={14} />} title={he ? "ביטול התזכורת" : "Cancel this timer"} end={when(x.due)} onSelect={() => cancel(x.id)} dir="auto">
          {x.prompt.length > 70 ? `${x.prompt.slice(0, 70)}…` : x.prompt}
        </MenuItem>
      ))}
    </Menu>
    </>
  );
}

/** One background command as the server lists it (background-commands.ts). */
interface BgCommand { id: string; command: string; state: "running" | "exited" | "stopped" | "ended"; exit?: number | null; startedAt: number; endedAt?: number }

/**
 * The chat's background commands (run_command with background:true), as chips at the top of the chat: a running one
 * "⏳ npm run build · 1:12 · Stop", a finished one (kept for 10 minutes) "✅ npm run build · exit 0 · Show output".
 * "Show output" opens the end of the output under the row. Looks at the server every 3 s while one runs.
 *
 * @param props.convId - The chat.
 */
export function BackgroundCommandsRow({ convId }: { convId: string }) {
  const [cmds, setCmds] = useState<BgCommand[]>([]);
  const [now, setNow] = useState(Date.now());
  const [gone, setGone] = useState<string[]>([]);
  const [shown, setShown] = useState<{ id: string; text: string } | null>(null);
  const he = getLocale() === "he";
  const running = cmds.some((c) => c.state === "running");
  useEffect(() => {
    const load = () => !document.hidden && void api<{ commands: BgCommand[] }>(`/api/conversations/${encodeURIComponent(convId)}/commands`).then((r) => (setCmds(r.commands), setNow(Date.now())), () => undefined);
    load();
    const t = window.setInterval(load, running ? 3_000 : 30_000);
    addEventListener("focus", load);
    return () => (window.clearInterval(t), removeEventListener("focus", load));
  }, [convId, running]);
  useEffect(() => {
    if (!running) return;
    const t = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(t);
  }, [running]);
  const base = `/api/conversations/${encodeURIComponent(convId)}/commands`;
  const stop = (id: string) => void api(`${base}/${encodeURIComponent(id)}/stop`, { method: "POST" }).then(() => setCmds((x) => x.map((c) => (c.id === id ? { ...c, state: "stopped" } : c))), (e: Error) => toast(e.message));
  const show = (id: string) =>
    shown?.id === id
      ? setShown(null)
      : void api<{ output: string }>(`${base}/${encodeURIComponent(id)}/output?tail=30`).then((r) => setShown({ id, text: r.output }), (e: Error) => toast(e.message));
  const visible = cmds.filter((c) => (c.state === "running" || now - (c.endedAt ?? c.startedAt) < 600_000) && !gone.includes(c.id)).slice(0, 6);
  if (!visible.length) return null;
  return (
    <div className="bgcmd-row">
      {visible.map((c) => {
        const ok = c.state === "exited" && c.exit === 0;
        const icon = c.state === "running" ? "⏳" : ok ? "✅" : c.state === "exited" ? "⚠️" : "⏹";
        const end = c.state === "exited" ? (he ? `קוד ${c.exit ?? "?"}` : `exit ${c.exit ?? "?"}`) : c.state === "stopped" ? (he ? "נעצר" : "stopped") : he ? "הסתיים עם KesherAI" : "ended with KesherAI";
        return (
          <span key={c.id} className={`bgcmd-chip${c.state === "running" ? "" : ok ? " ok" : " bad"}`} title={c.command} dir="auto">
            <span aria-hidden>{icon}</span>
            <span className="bgcmd-cmd" dir="ltr">{c.command}</span>
            <span className="bgcmd-time">· {c.state === "running" ? clockText(now - c.startedAt) : end}</span>
            {c.state === "running" ? (
              <button type="button" className="checkback-cancel" onClick={() => stop(c.id)} aria-label={he ? `עצירת ${c.command}` : `Stop ${c.command}`}>· {he ? "עצירה" : "Stop"}</button>
            ) : (
              <>
                <button type="button" className="checkback-cancel" onClick={() => show(c.id)} aria-expanded={shown?.id === c.id}>· {he ? "הצג פלט" : "Show output"}</button>
                <button type="button" className="checkback-cancel" onClick={() => setGone((g) => [...g, c.id])} aria-label={he ? "הסתרה" : "Dismiss"}>×</button>
              </>
            )}
          </span>
        );
      })}
      {shown && <pre className="bgcmd-out" dir="ltr">{shown.text || (he ? "(אין פלט)" : "(no output)")}</pre>}
    </div>
  );
}

/** Opens this chat's canvas (made on first open). */
export function openChatCanvas(convId: string): void {
  void api<{ id: string }>(`/api/conversations/${encodeURIComponent(convId)}/canvas`, { method: "POST" }).then(
    (d) => (location.hash = `#/canvas/${d.id}`),
    (e: Error) => toast(e.message),
  );
}

/**
 * The chat's Canvas button, once the chat has one (the model drew on it, or the user opened it from the ⋯ menu):
 * like LM Studio's Canvas, the board the user and the model draw on together.
 *
 * @param props.convId - The chat.
 * @param props.events - How many events the chat has (a new one may be the model's drawing: look again).
 */
export function CanvasButton({ convId, events }: { convId: string; events: number }) {
  const [has, setHas] = useState(false);
  const he = getLocale() === "he";
  useEffect(() => {
    if (has) return;
    const t = window.setTimeout(() => void api(`/api/canvases/chat-${encodeURIComponent(convId)}`).then(() => setHas(true), () => undefined), 400);
    return () => window.clearTimeout(t);
  }, [convId, events, has]);
  if (!has) return null;
  return (
    <button type="button" className="pane-btn" onClick={() => openChatCanvas(convId)} title={he ? "הקנבס של הצ'אט: לוח שאתם והמודל מציירים עליו" : "This chat's canvas: a board you and the model draw on"} aria-label={he ? "קנבס" : "Canvas"}>
      <LineIcon name="palette" size={16} />
    </button>
  );
}

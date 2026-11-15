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
interface WaitingTimer { id: string; prompt: string; due: number }

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
  return (
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

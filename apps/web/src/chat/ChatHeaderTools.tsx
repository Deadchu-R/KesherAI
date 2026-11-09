/** The chat's header tools: an agent group, a planner/reviewer team, and saving the chat as a file. */
import { useEffect, useRef, useState } from "react";
import type { ModelInfo, Teammate } from "@kesher/shared";
import { withToken } from "../api";
import { getLocale, t } from "../i18n";
import { desktop, toast } from "../library";
import { ModelMenu } from "../ModelMenu";
import { usePersonas } from "../Personas";

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

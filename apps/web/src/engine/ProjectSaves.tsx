import { useEffect, useState } from "react";
import { api } from "../api";
import { getLocale, he$ } from "../i18n";
import { toast } from "../library";
import { sizeText } from "./GameCheckpoints";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);

/** A save from an editor into a game project, as /api/project-assets/saves lists it. */
interface SaveView {
  id: string;
  engine: "unity" | "unreal";
  projectName: string;
  path: string;
  target: string;
  mode: "replace" | "new";
  size: number;
  at: string;
  fromPhone: boolean;
  state: "pending" | "working" | "done" | "failed" | "discarded";
  error?: string;
}

/**
 * Saves from the editors that wait for the computer ("Open from project": a phone can open a project's asset and
 * save it, but only the computer writes it into the project). On the Game projects page; each card says what is
 * written where, that a checkpoint is kept first, and Approve or Discard. Shown only when one waits; on the phone the
 * cards say they wait for the computer.
 */
export function ProjectSaves() {
  const [list, setList] = useState<SaveView[]>([]);
  const [canApprove, setCanApprove] = useState(false);
  const [busy, setBusy] = useState("");
  useEffect(() => {
    let alive = true;
    const tick = () => api<{ saves: SaveView[]; canApprove: boolean }>("/api/project-assets/saves").then((r) => { if (alive) { setList(r.saves.filter((s) => s.state === "pending" || s.state === "working")); setCanApprove(r.canApprove); } }, () => undefined);
    tick();
    const t = setInterval(tick, 5000);
    return () => { alive = false; clearInterval(t); };
  }, []);
  if (!list.length) return null;
  const act = async (s: SaveView, what: "approve" | "discard") => {
    setBusy(s.id);
    try {
      const r = await api<{ save?: SaveView }>(`/api/project-assets/saves/${encodeURIComponent(s.id)}/${what}`, { method: "POST" });
      if (what === "approve") toast(r.save?.state === "done" ? L(`נשמר ב-${s.projectName}: ${s.target}`, `Saved into ${s.projectName}: ${s.target}`) : `${L("השמירה נכשלה", "The save failed")}: ${r.save?.error ?? ""}`);
      setList((l) => l.filter((x) => x.id !== s.id));
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy("");
    }
  };
  return (
    <section className="project-saves" aria-label={L("שמירות שמחכות לאישור", "Saves waiting for approval")}>
      {list.map((s) => (
        <div key={s.id} className="card project-save">
          <div className="row wrap gap">
            <strong className="grow" dir="auto">💾 {s.projectName}</strong>
            <span className="games-chip">{s.engine === "unity" ? "Unity" : "Unreal"}</span>
            {s.fromPhone && <span className="games-chip">📱 {L("מהטלפון", "From the phone")}</span>}
          </div>
          <p className="small" dir="ltr">{s.mode === "replace" ? s.target : `${s.path} → ${s.target}`}</p>
          <p className="muted small">
            {s.mode === "replace" ? L("כותב מעל הקובץ המקורי.", "Writes over the original.") : L("נכס חדש ליד המקורי.", "A new asset next to the original.")} {L("נקודת שחזור נשמרת קודם.", "A checkpoint is kept first.")} {s.engine === "unreal" ? L("Unreal מייבא אותו ברקע.", "Unreal imports it in the background.") : L("Unity יטען אותו כשיחזור לפוקוס.", "Unity reimports it when it gets focus.")} · {sizeText(s.size)}
          </p>
          {canApprove ? (
            <div className="row gap">
              <button type="button" className="primary" disabled={!!busy || s.state === "working"} onClick={() => void act(s, "approve")}>{busy === s.id ? "…" : L("אשר ושמור", "Approve and save")}</button>
              <button type="button" className="ghost" disabled={!!busy} onClick={() => void act(s, "discard")}>{L("בטל", "Discard")}</button>
            </div>
          ) : (
            <div className="row gap">
              <span className="muted small grow">{L("מחכה לאישור במחשב", "Waiting for the computer to approve")}</span>
              <button type="button" className="ghost small" disabled={!!busy} onClick={() => void act(s, "discard")}>{L("בטל", "Discard")}</button>
            </div>
          )}
        </div>
      ))}
    </section>
  );
}

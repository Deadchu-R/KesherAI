import { useEffect, useState } from "react";
import { api } from "../api";
import { getLocale, he$ } from "../i18n";
import { toast } from "../library";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);

/** The strengths a model can have (packages/core/src/model-router.ts STRENGTHS), in the order shown. */
const STRENGTHS = ["tools", "hebrew", "code", "research", "vision", "fast"] as const;
type Strength = (typeof STRENGTHS)[number];

interface AutoRow { id: string; name: string; where: "local" | "server" | "cloud"; strengths: Strength[]; custom: boolean; loaded: boolean; loadSec?: number }
interface AutoState { defaultAuto: boolean; cloudKinds: Strength[]; models: AutoRow[]; labels: Record<Strength, { he: string; en: string }> }
interface RouterState { model: { name: string; sizeGb: number; note: { en: string; he?: string } }; downloaded: boolean; beside: string | null; job?: { phase: "downloading" | "loading" | "error"; message?: string } }

const ICON: Record<Strength, string> = { tools: "🧰", hebrew: "✍️", code: "💻", research: "🔎", vision: "🖼️", fast: "⚡" };
/** The most rows shown before "Show all" (a cloud connection can list many models). */
const FEW = 8;

/**
 * Settings › Models › Auto (RESEARCH_LOG "'Auto' model per message"): whether new chats start on Auto, which kinds of
 * message may go to a cloud model, each model's strengths (from its family until the user changes them), and the
 * small router model to load beside the big one.
 */
export function AutoModelSection() {
  const [st, setSt] = useState<AutoState | null>(null);
  const [all, setAll] = useState(false);
  useEffect(() => {
    void api<AutoState>("/api/model-router").then(setSt, () => undefined);
  }, []);
  if (!st) return null;
  const put = (body: Record<string, unknown>) => void api<AutoState>("/api/model-router", { method: "PUT", body }).then(setSt, (e: Error) => toast(e.message));
  const name = (k: Strength) => (getLocale() === "he" ? he$(st.labels[k].he) : st.labels[k].en);
  const toggle = (list: readonly Strength[], k: Strength) => (list.includes(k) ? list.filter((x) => x !== k) : [...list, k]);
  const rows = all ? st.models : st.models.slice(0, FEW);
  return (
    <section className="card stack auto-model">
      <h2>✨ {L("מודל אוטומטי", "Auto model")}</h2>
      <p className="muted small">{L("באוטומטי, כל הודעה הולכת למודל שהכי מתאים לה, וליד התשובה כתוב איזה מודל ענה ולמה. המודל הגדול שטעון נשאר, אלא אם מודל אחר ברור שעדיף (טקסט ארוך בעברית, משימה עם כמה כלים); החלפה לוקחת כמה שניות.", "On Auto, each message goes to the model that suits it best, and the reply says which model answered and why. The big loaded model stays unless another is clearly better (a long Hebrew text, a task with several tools); a swap takes a few seconds.")}</p>
      <label className="row">
        <input type="checkbox" checked={st.defaultAuto} onChange={(e) => put({ defaultAuto: e.target.checked })} />
        <span className="grow">{L("צ'אט חדש מתחיל באוטומטי", "New chats start on Auto")}</span>
      </label>
      <div className="auto-block">
        <span className="small">☁️ {L("מה מותר לשלוח למודל בענן", "What may go to a cloud model")}</span>
        <div className="auto-chips" role="group" aria-label={L("מה מותר לשלוח למודל בענן", "What may go to a cloud model")}>
          {STRENGTHS.map((k) => (
            <button key={k} type="button" className={`auto-chip${st.cloudKinds.includes(k) ? " on" : ""}`} aria-pressed={st.cloudKinds.includes(k)} onClick={() => put({ cloudKinds: toggle(st.cloudKinds, k) })}>{ICON[k]} {name(k)}</button>
          ))}
        </div>
        <p className="muted small">{L("צ'אט בגלישה בסתר לא נשלח לענן אף פעם.", "An incognito chat never goes to the cloud.")}</p>
      </div>
      <div className="auto-block">
        <span className="small">{L("במה כל מודל טוב", "What each model is good at")}</span>
        {!st.models.length && <p className="muted small">{L("אין עדיין מודלים לצ'אט.", "No chat models yet.")}</p>}
        {rows.map((m) => (
          <div key={m.id} className="auto-model-row">
            <div className="row auto-model-head">
              <strong className="grow" dir="ltr">{m.name}</strong>
              <span className={`where-tag ${m.where}`}>{m.where === "cloud" ? L("ענן", "Cloud") : m.where === "server" ? L("שרת", "Server") : m.loaded ? L("טעון", "Loaded") : L("במחשב", "On this computer")}</span>
              {m.custom && <button type="button" className="link-btn small" onClick={() => put({ strengths: { modelId: m.id, list: null } })}>{L("ברירת מחדל", "Default")}</button>}
            </div>
            <div className="auto-chips" role="group" aria-label={m.name}>
              {STRENGTHS.map((k) => (
                <button key={k} type="button" className={`auto-chip small${m.strengths.includes(k) ? " on" : ""}`} aria-pressed={m.strengths.includes(k)} onClick={() => put({ strengths: { modelId: m.id, list: toggle(m.strengths, k) } })}>{ICON[k]} {name(k)}</button>
              ))}
            </div>
          </div>
        ))}
        {st.models.length > FEW && <button type="button" className="link-btn small" onClick={() => setAll(!all)}>{all ? L("פחות", "Fewer") : L(`הצג את כל ה-${st.models.length}`, `Show all ${st.models.length}`)}</button>}
      </div>
      <RouterModelCard />
    </section>
  );
}

/**
 * The small router model for Auto (recommended, never downloaded by itself): one click downloads it when needed and
 * loads it beside the big model. Without it, Auto decides by words and the loaded model. Shown in Settings and on the
 * Models page.
 */
export function RouterModelCard() {
  const [r, setR] = useState<RouterState | null>(null);
  const load = () => void api<RouterState>("/api/model-router/router").then(setR, () => undefined);
  useEffect(() => {
    load();
  }, []);
  // While it downloads or loads, the card checks every few seconds.
  useEffect(() => {
    if (!r?.job || r.job.phase === "error") return;
    const id = setInterval(load, 3000);
    return () => clearInterval(id);
  }, [r?.job?.phase]);
  if (!r) return null;
  const note = getLocale() === "he" && r.model.note.he ? he$(r.model.note.he) : r.model.note.en;
  return (
    <div className="router-card">
      <div className="row">
        <span className="grow"><strong>🧭 {L("מודל נתב", "Router model")}</strong> <span dir="ltr">{r.model.name}</span> <span className="muted small">· {r.model.sizeGb} GB</span></span>
        {r.beside ? (
          <span className="pill good">{L("טעון ליד הראשי", "Loaded beside")}</span>
        ) : r.job && r.job.phase !== "error" ? (
          <span className="muted small">⟳ {r.job.phase === "downloading" ? L("מוריד…", "Downloading…") : L("טוען…", "Loading…")}</span>
        ) : (
          <button type="button" className="primary small" onClick={() => void api<RouterState>("/api/model-router/router/setup", { method: "POST" }).then(setR, (e: Error) => toast(e.message))}>
            {r.downloaded ? L("טען ליד הראשי", "Load beside") : L("הורד וטען", "Download and load")}
          </button>
        )}
      </div>
      <p className="muted small">{note} {!r.beside && L("בלעדיו, האוטומטי מחליט לפי המילים ולפי המודל הטעון.", "Without it, Auto decides by the words and the loaded model.")}</p>
      {r.job?.phase === "error" && <p className="error small">{r.job.message}</p>}
    </div>
  );
}

/**
 * "This tool works better with another model": a line at the top of a tool (Study, chat reports, code) when another
 * model scores clearly higher for this tool on this computer (0–100: quality, fit for the tool, speed here). Up to two
 * options: the best model already on the computer, and a better one to download, each with its score (hover for the
 * parts), size and whether it fits on the graphics card. Never switches by itself; "Keep" is remembered for this tool
 * and this model. Logic: @kesher/shared model-fit.
 */
import { useEffect, useState } from "react";
import { api } from "./api";
import { getLocale, he$ } from "./i18n";
import { toast } from "./library";
import type { ModelScore, ModelSuggestion, ModelTool } from "@kesher/shared";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);
/** A score with its parts on hover. */
function Score({ s }: { s: ModelScore }) {
  const parts = L(`איכות ${s.quality}/40 · התאמה לכלי ${s.fit}/35 · מהירות במחשב הזה ${s.speed}/25 (~${Math.round(s.tokensPerSecond)} טוקנים בשנייה)`, `Quality ${s.quality}/40 · fit for this tool ${s.fit}/35 · speed on this computer ${s.speed}/25 (~${Math.round(s.tokensPerSecond)} tokens/s)`);
  return <span className="pill small model-score" title={parts} aria-label={`${s.total}/100: ${parts}`}>{s.total}/100</span>;
}
const keepKey = (tool: ModelTool, loaded: string) => `kesher-model-keep:${tool}:${loaded}`;

/** The suggestion line for one tool; nothing while the loaded model fits or after "Keep". */
export function ModelSuggest({ tool }: { tool: ModelTool }) {
  const [s, setS] = useState<{ suggestion: ModelSuggestion | null; loaded: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [kept, setKept] = useState(false);
  useEffect(() => {
    void api<{ suggestion: ModelSuggestion | null; loaded: string | null }>(`/api/models/suggest?tool=${tool}&lang=${getLocale()}`).then(setS, () => undefined);
  }, [tool]);
  const loaded = s?.loaded ?? "";
  useEffect(() => {
    try {
      setKept(!!loaded && localStorage.getItem(keepKey(tool, loaded)) === "1");
    } catch {
      setKept(false);
    }
  }, [tool, loaded]);
  const sug = s?.suggestion;
  if (!sug || kept) return null;
  const keep = () => {
    setKept(true);
    try {
      localStorage.setItem(keepKey(tool, loaded), "1");
    } catch {
      // this visit only
    }
  };
  const run = async (f: () => Promise<unknown>, done: string) => {
    setBusy(true);
    try {
      await f();
      toast(done);
      setS({ suggestion: null, loaded });
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const where = (gpu: boolean) => (gpu ? L("נכנס כולו לכרטיס", "fits on the graphics card") : L("חלקו בזיכרון, איטי יותר", "partly in memory, slower"));
  return (
    <div className="card model-suggest" role="status">
      <span aria-hidden="true">💡</span>
      <div className="grow">
        {sug.loaded && sug.options.length > 0 && (
          <div className="small muted">{L("מתאים יותר לכלי הזה במחשב הזה. עכשיו:", "A better fit for this tool on this computer. Now:")} <span dir="ltr">{sug.loaded.name}</span> <Score s={sug.loaded.score} /></div>
        )}
        {sug.options.map((o) => (
          <div key={o.kind} className="row model-suggest-row">
            <span className="grow small">
              <b dir="ltr">{o.name}</b> <Score s={o.score} />{" "}
              <span className="muted">({o.sizeGb} GB · {o.kind === "switch" ? L("כבר במחשב", "on the computer") : L("להורדה", "to download")} · {where(o.score.fitsGpu)})</span>
            </span>
            {o.kind === "switch" ? (
              <button type="button" className="primary small" disabled={busy} onClick={() => void run(() => api("/api/engines/llamacpp/load", { method: "POST", body: { modelPath: o.path } }), L(`${o.name} נטען.`, `${o.name} loaded.`))}>{L("החלף", "Switch")}</button>
            ) : (
              <button type="button" className="small" disabled={busy} onClick={() => void run(() => api(`/api/models/recommended/${encodeURIComponent(o.id)}/run`, { method: "POST" }), L("ההורדה התחילה. אפשר לעקוב בעיגול ההורדות.", "The download started; follow it in the downloads circle."))}>{L("הורד והחלף", "Download and switch")}</button>
            )}
          </div>
        ))}
        {sug.context && (
          <div className="row model-suggest-row">
            <span className="grow small">{L(`כל צ'אט מקבל ${Math.round(sug.context.have / 1024)}K של הקשר, ולכלי הזה מומלץ ${Math.round(sug.context.want / 1024)}K לפחות.`, `Each chat gets ${Math.round(sug.context.have / 1024)}K of context; this tool works best with ${Math.round(sug.context.want / 1024)}K or more.`)}</span>
            <a className="button small" href="#/models">{L("הגדרות מודל", "Model settings")}</a>
          </div>
        )}
      </div>
      <button type="button" className="ghost small" onClick={keep} title={L("לא להציע שוב לכלי ולמודל האלה", "Don't suggest again for this tool and model")}>{L("השאר", "Keep")}</button>
    </div>
  );
}

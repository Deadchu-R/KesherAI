/**
 * Engine memory, visible (docs/VISION.md): before a model loads, what llama.cpp will do with it on this
 * computer, from its own fitting tool. Layers on each graphics card, memory used and left, and whether it fits
 * next to what is loaded now. Also the memory to leave free on the card for a game or an editor.
 */
import { useEffect, useState } from "react";
import { api } from "./api";
import { getLocale } from "./i18n";
import { toast } from "./library";
import { Select } from "./ui/Select";

const L = (he: string, en: string) => (getLocale() === "he" ? he : en);

interface FitPlan {
  ok: boolean;
  devices: Array<{ name: string; layers: number; usedMiB: number; freeMiB: number }>;
  totalLayers?: number;
  gpuLayers: number;
  context?: number;
  inSystemMemory: boolean;
  ms: number;
  loadedNow: string | null;
  marginMiB: number;
}

const gb = (mib: number) => (mib / 1024).toFixed(mib < 10240 ? 1 : 0);

/**
 * "What fits?" next to a model: runs the check and shows its answer in plain words.
 *
 * @param p.path - The model file.
 * @param p.name - Its file name (to tell when it is the one loaded now).
 */
export function FitButton({ path, name }: { path: string; name: string }) {
  const [plan, setPlan] = useState<FitPlan | null>(null);
  const [busy, setBusy] = useState(false);
  const run = () => {
    setBusy(true);
    void api<FitPlan>("/api/models/fit", { method: "POST", body: { modelPath: path } }).then(
      (p) => (setPlan(p), setBusy(false)),
      (e: Error) => (setBusy(false), toast(e.message)),
    );
  };
  const all = plan && plan.totalLayers !== undefined && plan.gpuLayers >= plan.totalLayers && !plan.inSystemMemory;
  return (
    <>
      <button type="button" disabled={busy} onClick={run} title={L("מה llama.cpp יעשה עם המודל הזה במחשב הזה, לפני שטוענים אותו", "What llama.cpp will do with this model on this computer, before loading it")}>
        {busy ? L("בודק…", "Checking…") : L("מה נכנס?", "What fits?")}
      </button>
      {plan && (
        <div className="fit-plan small" role="status">
          <strong className={plan.ok && all ? "fit-good" : plan.ok ? "fit-mid" : "fit-bad"}>
            {!plan.ok
              ? L("לא נכנס בזיכרון הפנוי עכשיו.", "Does not fit in the free memory now.")
              : all
                ? L("נכנס כולו לכרטיס המסך: מהירות מלאה.", "Fits on the graphics card entirely: full speed.")
                : plan.inSystemMemory
                  ? L("חלקים ממנו בזיכרון המחשב: עובד, אבל לאט יותר.", "Parts of it in system memory: it works, but slower.")
                  : L(`${plan.gpuLayers} מתוך ${plan.totalLayers ?? "?"} שכבות בכרטיס, השאר בזיכרון המחשב: לאט יותר.`, `${plan.gpuLayers} of ${plan.totalLayers ?? "?"} layers on the card, the rest in system memory: slower.`)}
          </strong>
          {plan.devices.map((d) => (
            <span key={d.name} className="muted" dir="auto">
              {d.name}: {L(`${d.layers} שכבות, ${gb(d.usedMiB)} GB בשימוש, ${gb(d.freeMiB)} GB נשאר פנוי`, `${d.layers} layers, ${gb(d.usedMiB)} GB used, ${gb(d.freeMiB)} GB left free`)}
            </span>
          ))}
          {plan.context && <span className="muted">{L(`הקשר: ${Math.round(plan.context / 1000)}K טוקנים`, `Context: ${Math.round(plan.context / 1000)}K tokens`)}</span>}
          {plan.loadedNow && (
            <span className="muted">
              {plan.loadedNow === name
                ? L("המודל הזה טעון עכשיו, אז הבדיקה רואה את הכרטיס תפוס על ידו. לתמונה המלאה: פרקו אותו ובדקו שוב.", "This model is loaded now, so the check sees the card taken by it. For the full picture: unload it and check again.")
                : L(`נמדד כש-${plan.loadedNow} טעון: זה מה שנכנס לידו.`, `Measured with ${plan.loadedNow} loaded: this is what fits next to it.`)}
            </span>
          )}
        </div>
      )}
    </>
  );
}

/**
 * "Leave free on the graphics card": the memory fitting keeps free, for a game or the Unreal/Unity editor on the
 * same card. Changing it loads the running model again.
 */
export function FitMargin() {
  const [mib, setMib] = useState<number | null>(null);
  useEffect(() => {
    void api<{ fitTargetMiB?: number }>("/api/engines/llamacpp").then((r) => setMib(r.fitTargetMiB ?? 2048), () => undefined);
  }, []);
  if (mib === null) return null;
  const set = (v: number) => void api<{ fitTargetMiB?: number }>("/api/engines/llamacpp/settings", { method: "PUT", body: { fitTargetMiB: v } }).then((r) => setMib(r.fitTargetMiB ?? v), (e: Error) => toast(e.message));
  return (
    <label className="row" title={L("כמה זיכרון בכרטיס המסך להשאיר פנוי כשטוענים מודל: למשחק, ל-Unreal או ל-Unity על אותו כרטיס", "How much graphics memory to keep free when a model loads: for a game, Unreal or Unity on the same card")}>
      <span>{L("להשאיר פנוי בכרטיס המסך", "Leave free on the graphics card")}</span>
      <Select value={mib} onChange={(e) => set(Number(e.target.value))}>
        {[1024, 2048, 3072, 4096, 6144, 8192].map((v) => <option key={v} value={v}>{v / 1024} GB{v === 2048 ? L(" (ברירת מחדל)", " (default)") : ""}</option>)}
      </Select>
    </label>
  );
}

interface CalRow { kv: "f16" | "q8_0"; depth: number; read?: number; write?: number }
interface CalState {
  run: { model: string; status: "running" | "done" | "failed" | "stopped"; step: number; steps: number; rows: CalRow[]; advice?: { kv: "f16" | "q8_0"; why: string; whyHe: string }; error?: string } | null;
  kvType: "f16" | "q8_0";
  saved: Record<string, { at: string; gpu: string; rows: CalRow[]; kv: "f16" | "q8_0" }>;
}

/**
 * "Calibrate": measures this model on this computer (llama-bench, about 5 minutes, the chat model unloaded for
 * it) and recommends the context memory type, with one tap to use it. The last result stays next to the model.
 *
 * @param p.path - The model file.
 * @param p.name - Its file name.
 */
export function CalibrateButton({ path, name }: { path: string; name: string }) {
  const [st, setSt] = useState<CalState | null>(null);
  const [open, setOpen] = useState(false);
  const load = () => void api<CalState>("/api/models/calibrate").then(setSt, () => undefined);
  const mine = st?.run?.model === name ? st.run : null;
  const running = mine?.status === "running";
  useEffect(() => {
    if (!open && !running) return;
    load();
    const t = window.setInterval(() => !document.hidden && load(), 3000);
    return () => window.clearInterval(t);
  }, [open, running]);
  const start = () => {
    if (!confirm(L("הכיול פורק את המודל של הצ׳אט לכחמש דקות, מודד, וטוען אותו חזרה. להתחיל?", "Calibrating unloads the chat model for about 5 minutes, measures, and loads it back. Start?"))) return;
    setOpen(true);
    void api<CalState>("/api/models/calibrate", { method: "POST", body: { modelPath: path } }).then(load, (e: Error) => toast(e.message));
  };
  const saved = st?.saved[name];
  const rows = mine?.rows.length ? mine.rows : saved?.rows ?? [];
  const advice = mine?.advice ?? (saved ? { kv: saved.kv } : undefined);
  const use = (kv: "f16" | "q8_0") => void api("/api/engines/llamacpp/settings", { method: "PUT", body: { kvType: kv } }).then(() => (toast(L("נשמר. המודל נטען מחדש.", "Saved. The model loads again.")), load()), (e: Error) => toast(e.message));
  return (
    <>
      <button type="button" onClick={() => (open ? setOpen(false) : (setOpen(true), load()))} title={L("מודד את המודל במחשב הזה וממליץ על ההגדרה", "Measures this model on this computer and recommends the setting")}>
        {running ? L(`מכייל… ${mine!.step}/${mine!.steps}`, `Calibrating… ${mine!.step}/${mine!.steps}`) : L("כיול", "Calibrate")}
      </button>
      {open && st && (
        <div className="fit-plan small">
          {running && (
            <span className="row wrap">
              <span className="muted grow">{L("מודד קריאה וכתיבה בהקשר 8 ו-16 ביט, בתחילת שיחה ועמוק בתוכה (16K, 48K)…", "Measuring reading and writing with 8- and 16-bit context, at the start of a chat and deep into one (16K, 48K)…")}</span>
              <button type="button" onClick={() => void api("/api/models/calibrate/stop", { method: "POST" }).then(load)}>{L("עצור", "Stop")}</button>
            </span>
          )}
          {mine?.status === "failed" && <span className="error" dir="auto">{mine.error}</span>}
          {rows.length > 0 && (
            <table className="cal-table">
              <thead>
                <tr><th>{L("עומק", "Depth")}</th><th>{L("הקשר", "Context")}</th><th>{L("קריאה", "Reading")}</th><th>{L("כתיבה", "Writing")}</th></tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={`${r.kv}${r.depth}`}><td>{r.depth ? `${Math.round(r.depth / 1000)}K` : "0"}</td><td>{r.kv === "f16" ? "16 bit" : "8 bit"}</td><td>{r.read ?? "–"}</td><td>{r.write ?? "–"}</td></tr>
                ))}
              </tbody>
            </table>
          )}
          {rows.length > 0 && <span className="muted">{L("טוקנים לשנייה.", "Tokens per second.")}{saved && !mine ? ` ${L("נמדד", "Measured")} ${new Date(saved.at).toLocaleDateString()}${saved.gpu ? ` · ${saved.gpu}` : ""}.` : ""}</span>}
          {mine?.advice && <strong dir="auto">{L(mine.advice.whyHe, mine.advice.why)}</strong>}
          {advice && st.kvType !== advice.kv && !running && (
            <button type="button" className="primary" onClick={() => use(advice.kv)}>{L(`השתמש בהקשר ${advice.kv === "f16" ? "16" : "8"} ביט`, `Use ${advice.kv === "f16" ? "16" : "8"}-bit context`)}</button>
          )}
          {advice && st.kvType === advice.kv && !running && <span className="fit-good">✓ {L("זו ההגדרה שבשימוש.", "This is the setting in use.")}</span>}
          {!running && <button type="button" onClick={start}>{rows.length ? L("כייל שוב", "Calibrate again") : L("התחל כיול (כ-5 דקות)", "Start calibrating (about 5 minutes)")}</button>}
        </div>
      )}
    </>
  );
}

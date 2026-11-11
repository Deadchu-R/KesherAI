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

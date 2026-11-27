import { useEffect, useState } from "react";
import { checkExtraArgs, splitEngineArgs, type ModelLoadSettings, type SamplingValues } from "@kesher/shared";
import { api, isRemote } from "./api";
import { getLocale, he$ } from "./i18n";
import { toast } from "./library";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);

/** Two to four choices as pills; the first ("Auto") clears the setting. */
function Pills<T extends string>({ value, options, onChange, label }: { value: T | undefined; options: Array<[T | undefined, string]>; onChange: (v: T | undefined) => void; label: string }) {
  return (
    <div className="seg-pills" role="radiogroup" aria-label={label}>
      {options.map(([v, text]) => (
        <button key={text} type="button" role="radio" aria-checked={value === v} className={value === v ? "on" : ""} onClick={() => onChange(v)}>{text}</button>
      ))}
    </div>
  );
}

/** The model's sampling, as the server reports it (sampling-presets.ts `samplingSummary`). */
type SamplingInfo = { state: "custom" | "off" | "preset" | "none"; label?: string; agent?: SamplingValues; chat?: SamplingValues };

/** Sampling values as a short line, e.g. `temp 0.6 · top-p 0.95 · top-k 20`. */
function samplingText(v: SamplingValues | undefined): string {
  if (!v) return "";
  const parts: Array<[string, number | undefined]> = [["temp", v.temperature], ["top-p", v.topP], ["top-k", v.topK], ["min-p", v.minP], ["presence", v.presencePenalty]];
  return parts.filter(([, n]) => n !== undefined).map(([k, n]) => `${k} ${n}`).join(" · ");
}

/**
 * ⚙ next to a model in Models: its own load settings (as LM Studio keeps them per model), used every time that file
 * loads: the context size, the context memory, expert layers on the processor, flash attention and more llama.cpp
 * arguments (only load and sampling settings; the server refuses the rest). Empty means automatic, as before.
 *
 * @param p.path - The model file.
 * @param p.name - Its name, for the dialog's title.
 */
export function LoadSettingsButton({ path, name }: { path: string; name: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="icon-btn" onClick={() => setOpen(true)} title={L("הגדרות טעינה למודל הזה", "Load settings for this model")} aria-label={L("הגדרות טעינה למודל הזה", "Load settings for this model")}>⚙</button>
      {open && <LoadSettingsDialog path={path} name={name} onClose={() => setOpen(false)} />}
    </>
  );
}

function LoadSettingsDialog({ path, name, onClose }: { path: string; name: string; onClose: () => void }) {
  const [s, setS] = useState<ModelLoadSettings | null>(null);
  const [sampling, setSampling] = useState<SamplingInfo>({ state: "none" });
  const [ctx, setCtx] = useState("");
  const [moe, setMoe] = useState("");
  const [extra, setExtra] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void api<{ settings: ModelLoadSettings; sampling?: SamplingInfo }>(`/api/models/load-settings?path=${encodeURIComponent(path)}`).then(
      ({ settings, sampling: sm }) => {
        setS(settings);
        if (sm) setSampling(sm);
        setCtx(settings.ctx ? String(settings.ctx) : "");
        setMoe(settings.cpuMoe !== undefined ? String(settings.cpuMoe) : "");
        setExtra((settings.extra ?? []).map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(" "));
      },
      (e: Error) => (toast(e.message), onClose()),
    );
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    addEventListener("keydown", esc);
    return () => removeEventListener("keydown", esc);
  }, [path, onClose]);
  const extraArgs = splitEngineArgs(extra);
  const extraWrong = extra.trim() ? checkExtraArgs(extraArgs) : undefined;
  const save = async (settings: ModelLoadSettings, reload: boolean) => {
    setBusy(true);
    try {
      const r = await api<{ reloading: boolean }>("/api/models/load-settings", { method: "PUT", body: { path, settings, reload } });
      toast(r.reloading ? L("נשמר. המודל נטען מחדש עם ההגדרות.", "Saved. The model is loading again with them.") : L("נשמר. ייכנס לתוקף בטעינה הבאה של המודל.", "Saved. Used the next time this model loads."));
      onClose();
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const current = (): ModelLoadSettings => ({
    ...(ctx.trim() ? { ctx: Number(ctx) } : {}),
    ...(s?.kv ? { kv: s.kv } : {}),
    ...(moe.trim() ? { cpuMoe: Number(moe) } : {}),
    ...(s?.flash ? { flash: s.flash } : {}),
    ...(extraArgs.length ? { extra: extraArgs } : {}),
    ...(s?.samplingOff ? { samplingOff: true } : {}),
  });
  // The saved choice, then what the server reports (a typed --temp in the arguments makes it the user's own).
  const samplingState = sampling.state === "custom" ? "custom" : s?.samplingOff ? "off" : sampling.label ? "preset" : "none";
  const short = name.replace(/\.gguf$/i, "");
  return (
    <div className="dialog-backdrop" role="presentation" onClick={onClose}>
      <form className="dialog card stack load-settings" role="dialog" aria-modal="true" aria-label={L(`הגדרות טעינה: ${short}`, `Load settings: ${short}`)} onClick={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); if (!extraWrong) void save(current(), true); }}>
        <strong dir="auto">{L("הגדרות טעינה: ", "Load settings: ")}<span dir="ltr">{short}</span></strong>
        <p className="muted small">{L("נשמר לקובץ הזה בלבד ונכנס לתוקף בכל טעינה שלו. ריק = אוטומטי (כמו היום).", "Saved for this file only and used every time it loads. Empty = automatic (as now).")}</p>
        {!s ? <p className="muted">{L("טוען…", "Loading…")}</p> : (
          <>
            <div className="load-settings-grid">
              <label className="stack">
                <span className="small">{L("חלון הקשר (טוקנים)", "Context window (tokens)")}</span>
                <input type="number" inputMode="numeric" min={512} step={1024} dir="ltr" placeholder={L("אוטומטי", "Auto")} value={ctx} onChange={(e) => setCtx(e.target.value)} />
              </label>
              <div className="stack">
                <span className="small">{L("זיכרון ההקשר", "Context memory")}</span>
                <Pills label={L("זיכרון ההקשר", "Context memory")} value={s.kv} onChange={(kv) => setS({ ...s, ...{ kv } })} options={[[undefined, L("אוטומטי", "Auto")], ["f16", L("16 ביט", "16-bit")], ["q8_0", L("8 ביט", "8-bit")], ["q4_0", L("4 ביט", "4-bit")]]} />
              </div>
              <label className="stack">
                <span className="small">{L("שכבות מומחים (MoE) על המעבד", "Expert (MoE) layers on the processor")}</span>
                <input type="number" inputMode="numeric" min={0} dir="ltr" placeholder={L("אוטומטי", "Auto")} value={moe} onChange={(e) => setMoe(e.target.value)} />
              </label>
              <div className="stack">
                <span className="small">Flash attention</span>
                <Pills label="Flash attention" value={s.flash} onChange={(flash) => setS({ ...s, ...{ flash } })} options={[[undefined, L("אוטומטי", "Auto")], ["on", L("פועל", "On")], ["off", L("כבוי", "Off")]]} />
              </div>
            </div>
            <label className="stack">
              <span className="small">{L("ארגומנטים נוספים ל-llama.cpp", "More llama.cpp arguments")}</span>
              <input dir="ltr" className="mono" placeholder="--temp 0.7 --top-k 20" value={extra} onChange={(e) => setExtra(e.target.value)} aria-invalid={!!extraWrong} />
              <span className={extraWrong ? "error small" : "muted small"} dir="auto">{extraWrong ? <>{L("יש כאן ארגומנט שלא מותר, או בלי ערך: ", "")}<span dir="ltr">{extraWrong}</span></> : L("רק הגדרות של טעינה ודגימה; קבצים, פורטים ומפתחות נדחים.", "Only load and sampling settings; files, ports and keys are refused.")}</span>
            </label>
            {/* Sampling: where it comes from (the vendor's preset, the user's own, or llama.cpp's defaults). The phone only reads it. */}
            <div className="stack" data-testid="sampling-line">
              <span className="small" dir="auto">
                {samplingState === "preset" && <>{L("דגימה: ", "Sampling: ")}<span dir="ltr">{sampling.label}</span>{L(" מומלץ (סוכן)", " recommended (agent)")}</>}
                {samplingState === "custom" && L("דגימה: ההגדרות שלך", "Sampling: your own settings")}
                {samplingState === "off" && L("דגימה: ברירות המחדל של llama.cpp", "Sampling: llama.cpp defaults")}
                {samplingState === "none" && L("דגימה: ברירות המחדל של llama.cpp (אין ערך רשמי למשפחה הזו)", "Sampling: llama.cpp defaults (no official value for this family)")}
              </span>
              {samplingState === "preset" && (
                <span className="muted small" dir="ltr">{L("סוכן: ", "Agent: ")}{samplingText(sampling.agent)}{" | "}{L("שיחה: ", "Chat: ")}{samplingText(sampling.chat)}</span>
              )}
              {!isRemote() && sampling.label && samplingState !== "custom" && (
                <div className="row wrap">
                  <button type="button" disabled={busy} onClick={() => setS({ ...s, samplingOff: s.samplingOff ? undefined : true })}>
                    {s.samplingOff ? L("השתמש בערכים המומלצים", "Use the recommended values") : L("השתמש בברירות המחדל של llama.cpp", "Use llama.cpp defaults")}
                  </button>
                </div>
              )}
              {samplingState !== "none" && <span className="muted small">{isRemote() ? L("משנים במחשב.", "Change it on the computer.") : L("לערכים משלך: --temp, --top-p ועוד בארגומנטים למעלה.", "For your own values: --temp, --top-p and more in the arguments above.")}</span>}
            </div>
            <div className="row wrap">
              <button type="submit" className="primary" disabled={busy || !!extraWrong}>{L("שמור וטען מחדש", "Save and reload")}</button>
              <button type="button" disabled={busy || !!extraWrong} onClick={() => void save(current(), false)}>{L("שמור", "Save")}</button>
              <button type="button" disabled={busy} onClick={() => void save({}, true)}>{L("איפוס", "Reset")}</button>
              <span className="grow" />
              <button type="button" className="ghost" onClick={onClose}>{L("סגירה", "Close")}</button>
            </div>
          </>
        )}
      </form>
    </div>
  );
}

import { useEffect, useState } from "react";
import { api, isRemote } from "./api";
import { getLocale, he$ } from "./i18n";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);

type Rule = "light" | "ignore";
interface Settings { enabled: boolean; unloadGpu: boolean; keepCpuPool: boolean; pauseInbox: boolean; reloadWhenDone: boolean; programs: Record<string, Rule> }
interface Info { on: boolean; enabled: boolean; apps: string[]; unloaded: string[]; settings: Settings }

/**
 * The status line of the light profile ("Light profile: on (Slay the Spire 2)"), also shown on the phone.
 *
 * @param p - The status from /api/light-profile.
 */
export function lightLine(p: Pick<Info, "on" | "enabled" | "apps">): string {
  if (!p.enabled) return L("פרופיל קל: כבוי", "Light profile: off");
  if (!p.on) return L("פרופיל קל: לא פעיל, המחשב פנוי", "Light profile: idle, the computer is free");
  return L(`פרופיל קל: פעיל (${p.apps.slice(0, 2).join(", ")})`, `Light profile: on (${p.apps.slice(0, 2).join(", ")})`);
}

/**
 * Settings → Computer: the automatic light profile (heavy-app.ts). A game or a full-screen program makes KesherAI step
 * aside; what it does is set here, and a program can be forced to count ("light") or never count ("ignore"). The status
 * shows on the phone too; the settings change only on the computer.
 */
export function LightProfileSection() {
  const [info, setInfo] = useState<Info | null>(null);
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const remote = isRemote();
  const load = () => void api<Info>("/api/light-profile").then(setInfo, () => undefined);
  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, []);
  if (!info) return null;
  const s = info.settings;
  const save = (patch: Partial<Settings>) => {
    setError("");
    api<Info>("/api/light-profile", { method: "PUT", body: patch }).then(setInfo, (e: Error) => setError(e.message));
  };
  const flag = (key: Exclude<keyof Settings, "programs">, he: string, en: string) => (
    <label className="row small"><input type="checkbox" disabled={remote} checked={s[key]} onChange={(e) => save({ [key]: e.target.checked })} /> {L(he, en)}</label>
  );
  const setRule = (k: string, rule?: Rule) => {
    const next = { ...s.programs };
    if (rule) next[k] = rule;
    else delete next[k];
    save({ programs: next });
  };
  const entries = Object.entries(s.programs);

  return (
    <section className="card stack light-profile">
      <div className="row">
        <h2 className="grow">{L("פרופיל קל אוטומטי", "Automatic light profile")}</h2>
        {flag("enabled", "פעיל", "On")}
      </div>
      <p className={info.on ? "small" : "muted small"} dir="auto"><b>{lightLine(info)}</b>{info.unloaded.length > 0 && <span className="muted"> · {L("שוחררו", "freed")}: {info.unloaded.join(", ")}</span>}</p>
      <p className="muted small">{L("משחק או תוכנה במסך מלא מפעילים אותו; הוא נגמר דקה אחרי שהמחשב שקט.", "A game or a full-screen program turns it on; it ends a minute after the computer is quiet.")}</p>
      {flag("unloadGpu", "לשחרר את המודלים מכרטיס המסך", "Unload the models from the graphics card")}
      {flag("keepCpuPool", "להשאיר את המודלים הקטנים על המעבד פועלים", "Keep the small models on the processor running")}
      {flag("pauseInbox", "להשהות את הרצות תיבת המשימות המקומיות", "Pause the task inbox's local runs")}
      {flag("reloadWhenDone", "לטעון את המודלים חזרה כשזה נגמר", "Load the models back when it ends")}
      <h3>{L("תוכנות", "Programs")}</h3>
      {entries.length === 0 && <p className="muted small">{L("אין תוכנות ברשימה.", "No programs in the list.")}</p>}
      {entries.map(([k, rule]) => (
        <div className="row small" key={k}>
          <b className="grow" dir="ltr">{k}</b>
          <select value={rule} disabled={remote} onChange={(e) => setRule(k, e.target.value as Rule)}>
            <option value="light">{L("תמיד קל", "Always light")}</option>
            <option value="ignore">{L("להתעלם", "Ignore")}</option>
          </select>
          <button type="button" disabled={remote} onClick={() => setRule(k)} aria-label={L("הסר", "Remove")}>✕</button>
        </div>
      ))}
      {!remote && (
        <form className="row" onSubmit={(e) => { e.preventDefault(); if (name.trim()) { setRule(name.trim().replace(/\.exe$/i, "").toLowerCase(), "light"); setName(""); } }}>
          <input className="grow" dir="auto" value={name} maxLength={120} placeholder={L("שם תוכנה, למשל blender", "Program name, e.g. blender")} onChange={(e) => setName(e.target.value)} />
          <button type="submit">{L("הוסף", "Add")}</button>
        </form>
      )}
      {error && <p className="small error" dir="auto">{error}</p>}
    </section>
  );
}

import { useEffect, useState } from "react";
import { api } from "./api";
import { getLocale, he$, t } from "./i18n";
import type { LiveState } from "./control-live-view";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);

interface Status {
  enabled: boolean;
  active: boolean;
  app: string;
  log: Array<{ at: string; action: string; app: string; ok: boolean; note?: string }>;
  /** Windows UI Automation worker: none (not Windows), idle (starts on demand) or running. */
  uia?: "none" | "idle" | "running";
}

/** Settings → Computer control: the switch, the rules, and the action log. */
export function ComputerSection() {
  const [s, setS] = useState<Status | null>(null);
  const load = () => api<Status>("/api/computer/status").then(setS, () => undefined);
  useEffect(() => {
    void load();
    const id = setInterval(load, 4000);
    return () => clearInterval(id);
  }, []);
  if (!s) return null;
  const mac = /Mac/i.test(navigator.platform);
  return (
    <section className="card stack computer">
      <h2>{t("ccTitle")}</h2>
      <p className="muted small">{t("ccIntro")}</p>
      <label className="row cc-switch">
        <input type="checkbox" checked={s.enabled} onChange={(e) => void api<Status>("/api/computer", { method: "PUT", body: { enabled: e.target.checked } }).then(setS)} />
        <span>{t("ccEnable")}</span>
      </label>
      <ul className="cc-rules small">
        <li>{t("ccRuleApps")}</li>
        <li>{t("ccRuleBrowsers")}</li>
        <li>{t("ccRuleTerminals")}</li>
        <li>{t("ccRulePasswords")}</li>
        {s.uia && s.uia !== "none" && (
          <>
            <li>{L("ב־Windows המודל קורא את הכפתורים והשדות של החלון לפי שם ופועל עליהם בלי להזיז את העכבר.", "On Windows the model reads a window's buttons and fields by name and acts on them without moving the mouse.")}</li>
            <li>{L("שואל בכל פעם: שדות סיסמה, אפליקציות תשלום ובנק, מחיקת קבצים, לוח ההעתקה.", "Always asks: password fields, payment and bank apps, deleting files, the clipboard.")}</li>
            <li>{L("אף פעם: חלונות בקרת חשבון משתמש וכניסה, הגדרות המערכת והאבטחה.", "Never: User Account Control and sign-in windows, system and security settings.")}</li>
          </>
        )}
        <li>{t("ccRuleStop", { keys: mac ? "⌘⇧Esc" : "Ctrl+Alt+Esc" })}</li>
      </ul>
      {mac && <p className="muted small">{t("ccMac")}</p>}
      {s.uia && s.uia !== "none" && (
        <p className="muted small cc-uia" dir="auto">
          {L("קורא הפקדים של Windows (UI Automation): ", "Windows controls reader (UI Automation): ")}
          {s.uia === "running" ? L("פועל", "running") : L("כבוי, יופעל כשצריך", "off, starts when needed")}
        </p>
      )}
      {s.log.length > 0 && (
        <details>
          <summary className="small">{t("ccLog", { n: s.log.length })}</summary>
          <ol className="cc-log small">
            {[...s.log].reverse().map((a, i) => (
              <li key={i} className={a.ok ? "" : "bad"}>
                <span className="muted" dir="ltr">{a.at.slice(11, 19)}</span> <span dir="auto">{a.action}</span>
                {a.app && <span className="muted" dir="ltr"> · {a.app}</span>}
                {a.note && <span className="muted" dir="auto"> · {a.note}</span>}
              </li>
            ))}
          </ol>
        </details>
      )}
    </section>
  );
}

/**
 * A bar across the top while a model uses the browser or controls the computer, or while control is paused: what it
 * does, a link to the live view (#/watch, also on the phone) and one Stop for both. Not on the live view itself.
 *
 * @param p.hidden - Hide it (the live view has its own big Stop).
 */
export function ComputerBanner({ hidden }: { hidden?: boolean }) {
  const [s, setS] = useState<LiveState | null>(null);
  useEffect(() => {
    let alive = true;
    const tick = () => !document.hidden && api<LiveState>("/api/control/live?lite=1").then((x) => alive && setS(x), () => undefined);
    void tick();
    const id = setInterval(tick, 2000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);
  const active = !!s && (s.browser.active || (s.computer.enabled && s.computer.active));
  if (hidden || !s || (!active && !s.paused)) return null;
  const last = s.log.at(-1);
  const what = s.paused
    ? L("השליטה בדפדפן ובמחשב מושהית", "Browser and computer control is paused")
    : s.computer.active
      ? t("ccActive", { app: s.computer.app || "?" })
      : L(`KesherAI משתמש בדפדפן${last?.where ? ` · ${last.where}` : ""}`, `KesherAI is using the browser${last?.where ? ` · ${last.where}` : ""}`);
  const stop = () => void Promise.all([api("/api/browser/stop", { method: "POST" }), api("/api/computer/stop", { method: "POST" })]).then(() => setS({ ...s, browser: { ...s.browser, active: false }, computer: { ...s.computer, active: false } }), () => undefined);
  const resume = () => void api<{ paused: boolean }>("/api/control/pause", { method: "POST", body: { on: false } }).then((r) => setS({ ...s, paused: r.paused }), () => undefined);
  return (
    <div className={`cc-banner${s.paused ? " paused" : ""}`} role="status">
      <span className="dot" aria-hidden />
      <span dir="auto" className="cc-banner-text">{what}</span>
      <a href="#/watch">{L("צפייה", "Watch")}</a>
      {s.paused ? <button type="button" onClick={resume}>{L("המשך", "Resume")}</button> : <button type="button" onClick={stop}>{t("ccStop")}</button>}
    </div>
  );
}

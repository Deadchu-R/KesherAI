import { useEffect, useState } from "react";
import { api } from "./api";
import { t } from "./i18n";

interface Status {
  enabled: boolean;
  active: boolean;
  app: string;
  log: Array<{ at: string; action: string; app: string; ok: boolean; note?: string }>;
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
        <li>{t("ccRuleStop", { keys: mac ? "⌘⇧Esc" : "Ctrl+Alt+Esc" })}</li>
      </ul>
      {mac && <p className="muted small">{t("ccMac")}</p>}
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

/** A bar across the top while a model is controlling the computer, with Stop. */
export function ComputerBanner() {
  const [s, setS] = useState<Status | null>(null);
  useEffect(() => {
    let alive = true;
    const tick = () => api<Status>("/api/computer/status").then((x) => alive && setS(x), () => undefined);
    void tick();
    const id = setInterval(tick, 1500);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);
  if (!s?.enabled || !s.active) return null;
  const last = s.log.at(-1);
  return (
    <div className="cc-banner" role="status">
      <span className="dot" aria-hidden />
      <span dir="auto">{t("ccActive", { app: s.app || "?" })}{last ? ` · ${last.action}` : ""}</span>
      <button type="button" onClick={() => void api("/api/computer/stop", { method: "POST" }).then(() => setS({ ...s, active: false }))}>{t("ccStop")}</button>
    </div>
  );
}

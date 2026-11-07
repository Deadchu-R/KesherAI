import { useState } from "react";
import { t } from "./i18n";

const KEY = "kesher-web-search";

/** Whether "Search the web" is on (remembered per browser). */
export function useWebSearch(): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(() => {
    try {
      return localStorage.getItem(KEY) === "1";
    } catch {
      return false;
    }
  });
  return [
    on,
    (v) => {
      setOn(v);
      try {
        localStorage.setItem(KEY, v ? "1" : "0");
      } catch {
        // not remembered; fine
      }
    },
  ];
}

/**
 * The composer's globe button: when on, KesherAI searches the web for each
 * message and gives the results to the model (any model, even one without
 * tools), which answers from them and links its sources.
 *
 * @param props.on - Current state.
 * @param props.onChange - Toggles it.
 */
export function WebToggle({ on, onChange }: { on: boolean; onChange: (on: boolean) => void }) {
  return (
    <button type="button" className={`chip web-chip${on ? " on" : ""}`} aria-pressed={on} title={t("webHint")} onClick={() => onChange(!on)}>
      <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" strokeWidth="1.4" /><path d="M1.8 8h12.4M8 1.8c2 2.2 2 10.2 0 12.4M8 1.8c-2 2.2-2 10.2 0 12.4" fill="none" stroke="currentColor" strokeWidth="1.2" /></svg>
      <span>{t("web")}</span>
    </button>
  );
}

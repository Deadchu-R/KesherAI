import { useEffect, useState } from "react";
import { desktop } from "../library";
import { t } from "../i18n";

/** Desktop app: start with the computer, in the background (no window), so the phone and other computers can always reach it. */
export function StartupToggle() {
  const [on, setOn] = useState<boolean | null>(null);
  useEffect(() => {
    void desktop()?.startup?.().then(setOn, () => undefined);
  }, []);
  if (on === null || !desktop()?.startup) return null;
  return (
    <label className="check">
      <input type="checkbox" checked={on} onChange={(e) => void desktop()!.startup!(e.target.checked).then(setOn)} />
      {t("startWithComputer")}
    </label>
  );
}

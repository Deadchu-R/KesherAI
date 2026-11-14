import { useEffect, useState } from "react";
import type { WebPrefs } from "@kesher/shared";
import { BarPopover } from "./ui/BarPopover";
import { getLocale } from "./i18n";

const L = (he: string, en: string) => (getLocale() === "he" ? he : en);

/**
 * This chat's web search settings, beside the globe button: how deep (how many pages it reads), only these sites,
 * never these sites. They apply to the globe's search and to the model's own web_search / web_fetch.
 */
export function WebPrefsChip({
  value,
  onChange,
}: {
  value: WebPrefs | undefined;
  onChange: (w: WebPrefs | null) => void;
}) {
  const [depth, setDepth] = useState<NonNullable<WebPrefs["depth"]>>(
    value?.depth ?? "normal",
  );
  const [only, setOnly] = useState((value?.only ?? []).join(", "));
  const [never, setNever] = useState((value?.never ?? []).join(", "));
  useEffect(() => {
    setDepth(value?.depth ?? "normal");
    setOnly((value?.only ?? []).join(", "));
    setNever((value?.never ?? []).join(", "));
  }, [value]);
  const set = !!(
    value?.only?.length ||
    value?.never?.length ||
    (value?.depth && value.depth !== "normal")
  );
  const list = (t: string) =>
    t
      .split(/[\s,]+/)
      .map((x) => x.trim())
      .filter(Boolean);
  return (
    <BarPopover
      className={`web-prefs${set ? " on" : ""}`}
      icon={<span aria-hidden="true">⚙</span>}
      label={L("הגדרות חיפוש", "Search settings")}
      title={L(
        "איך הצ'אט הזה מחפש באינטרנט: עומק ואתרים",
        "How this chat searches the web: depth and sites",
      )}
      {...(set ? { badge: <span className="dot" /> } : {})}
    >
      {(close) => {
        // Not a <form>: the popover sits inside the composer's own form, and a form inside a form does not submit.
        const save = () => {
          const w: WebPrefs = {
            ...(depth !== "normal" ? { depth } : {}),
            ...(list(only).length ? { only: list(only) } : {}),
            ...(list(never).length ? { never: list(never) } : {}),
          };
          onChange(Object.keys(w).length ? w : null);
          close();
        };
        const enter = (e: React.KeyboardEvent) => {
          if (e.key === "Enter") {
            e.preventDefault();
            save();
          }
        };
        return (
          <div
            className="stack web-prefs-form"
            role="group"
            aria-label={L("הגדרות חיפוש", "Search settings")}
          >
            <strong>
              {L("חיפוש באינטרנט בצ'אט הזה", "Web search in this chat")}
            </strong>
            <fieldset className="stack small">
              <legend>{L("עומק", "Depth")}</legend>
              {(
                [
                  [
                    "quick",
                    L(
                      "מהיר — 5 תוצאות, עונה מהן",
                      "Quick: 5 results, answers from them",
                    ),
                  ],
                  [
                    "normal",
                    L(
                      "רגיל — 10 תוצאות, קורא 2–3 דפים",
                      "Normal: 10 results, reads 2-3 pages",
                    ),
                  ],
                  [
                    "deep",
                    L(
                      "עמוק — עד 20 תוצאות, קורא 5 דפים ויותר",
                      "Deep: up to 20 results, reads 5+ pages",
                    ),
                  ],
                ] as const
              ).map(([v, label]) => (
                <label key={v} className="check">
                  <input
                    type="radio"
                    name="depth"
                    checked={depth === v}
                    onChange={() => setDepth(v)}
                  />
                  {label}
                </label>
              ))}
            </fieldset>
            <label className="stack small">
              {L(
                "רק מהאתרים האלה (ריק = כל האינטרנט)",
                "Only these sites (empty: the whole web)",
              )}
              <input
                dir="ltr"
                value={only}
                onChange={(e) => setOnly(e.target.value)}
                onKeyDown={enter}
                placeholder="docs.unity3d.com, dev.epicgames.com"
              />
            </label>
            <label className="stack small">
              {L("אף פעם לא מהאתרים האלה", "Never these sites")}
              <input
                dir="ltr"
                value={never}
                onChange={(e) => setNever(e.target.value)}
                onKeyDown={enter}
                placeholder="pinterest.com"
              />
            </label>
            <div className="row">
              <button type="button" className="primary" onClick={save}>
                {L("שמור", "Save")}
              </button>
              {set && (
                <button
                  type="button"
                  onClick={() => {
                    onChange(null);
                    close();
                  }}
                >
                  {L("איפוס", "Reset")}
                </button>
              )}
            </div>
          </div>
        );
      }}
    </BarPopover>
  );
}

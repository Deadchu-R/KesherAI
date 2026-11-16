import { useEffect, useState } from "react";
import { SHORTCUTS, comboOf, shortcutConflicts, shortcutKey, type ShortcutMap } from "@kesher/shared";
import { api } from "../api";
import { getLocale, he$ } from "../i18n";
import { desktop, toast } from "../library";
import { setKeyboard, useKeyboard } from "../keyboard";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);
const isMac = () => /Mac|iPhone|iPad/.test(navigator.platform);

/**
 * Settings → Keyboard (as Open WebUI 0.11 and VS Code): every shortcut with its keys; Change, then press the new
 * keys (Esc cancels); Off; Reset; a warning when two share keys; and, in the desktop app, which global keys another
 * program holds. A master switch turns off the in-app ones.
 */
export function KeyboardSection() {
  const k = useKeyboard();
  const [recording, setRecording] = useState<string | null>(null);
  const [globals, setGlobals] = useState<Record<string, "ok" | "taken" | "off">>({});
  const bridge = desktop();
  const mac = isMac();

  useEffect(() => {
    void bridge?.keys?.().then(setGlobals, () => undefined);
  }, [bridge]);

  const save = async (shortcuts: ShortcutMap, off = k.off) => {
    try {
      const r = await api<{ shortcuts: ShortcutMap; off: boolean }>("/api/settings/keyboard", { method: "PUT", body: { shortcuts, off } });
      setKeyboard(r);
      // The desktop app registers the global keys again with the new combinations.
      const st = await bridge?.keys?.(true);
      if (st) setGlobals(st);
    } catch (e) {
      toast((e as Error).message);
    }
  };

  useEffect(() => {
    if (!recording) return;
    const def = SHORTCUTS.find((s) => s.id === recording);
    const key = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape" && !e.ctrlKey && !e.altKey && !e.metaKey) return setRecording(null);
      const combo = comboOf(e);
      if (!combo) return;
      if (def?.scope === "global" && !/(^|\+)(Ctrl|Cmd|Alt)\+/.test(combo)) return toast(L("מקש לכל המחשב צריך Ctrl או Alt (אחרת הוא יגזול הקלדה מכל תוכנה)", "A key for the whole computer needs Ctrl or Alt (otherwise it would take typing away from every program)"));
      if (!/(^|\+)(Ctrl|Cmd|Alt)\+/.test(combo)) return toast(L("צריך Ctrl או Alt", "Use Ctrl or Alt"));
      setRecording(null);
      void save({ ...k.shortcuts, [recording]: combo });
    };
    // Before the page's own shortcuts, so recording Ctrl+K does not open the palette.
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  });

  const conflicts = shortcutConflicts(k.shortcuts, mac);
  const nameOf = (id: string) => {
    const d = SHORTCUTS.find((s) => s.id === id);
    return d ? L(d.he, d.en) : id;
  };
  const row = (scope: "app" | "global") =>
    SHORTCUTS.filter((s) => s.scope === scope).map((s) => {
      const combo = shortcutKey(s.id, k.shortcuts, mac);
      const changed = s.id in k.shortcuts;
      const taken = scope === "global" && globals[s.id] === "taken";
      return (
        <div key={s.id} className="row kbd-row">
          <span className="grow" dir="auto">{L(s.he, s.en)}</span>
          {recording === s.id ? (
            <span className="kbd-recording" role="status">{L("הקישו את הצירוף החדש… (Esc לביטול)", "Press the new keys… (Esc cancels)")}</span>
          ) : (
            <kbd className={`kbd-combo${combo ? "" : " off"}${taken ? " taken" : ""}`} dir="ltr">{combo ?? L("כבוי", "Off")}</kbd>
          )}
          {taken && <span className="small fit-bad">{L("תוכנה אחרת תופסת אותו", "Another program holds it")}</span>}
          <button type="button" onClick={() => setRecording(recording === s.id ? null : s.id)}>{L("שינוי", "Change")}</button>
          {combo && <button type="button" onClick={() => void save({ ...k.shortcuts, [s.id]: null })}>{L("כיבוי", "Off")}</button>}
          {changed && (
            <button type="button" onClick={() => {
              const next = { ...k.shortcuts };
              delete next[s.id];
              void save(next);
            }}>{L("ברירת מחדל", "Default")}</button>
          )}
        </div>
      );
    });

  return (
    <section className="card stack">
      <h2>{L("מקלדת", "Keyboard")}</h2>
      <p className="muted small">{L("לחצו \"שינוי\" והקישו את הצירוף החדש.", "Press \"Change\", then the new keys.")}</p>
      {conflicts.map(([a, b]) => (
        <p key={a + b} className="small fit-bad" role="alert">{L(`"${nameOf(a)}" ו"${nameOf(b)}" על אותם מקשים: רק אחד יעבוד.`, `"${nameOf(a)}" and "${nameOf(b)}" share keys: only one will work.`)}</p>
      ))}
      <h3>{L("בכל המחשב", "Anywhere on the computer")}</h3>
      {bridge?.keys ? row("global") : <p className="muted small">{L("המקשים האלה עובדים באפליקציית המחשב של KesherAI.", "These keys work in KesherAI's desktop app.")}</p>}
      <h3 className="row">
        <span className="grow">{L("בתוך KesherAI", "Inside KesherAI")}</span>
        <label className="row small"><input type="checkbox" checked={!k.off} onChange={(e) => void save(k.shortcuts, !e.target.checked)} />{L("פעיל", "On")}</label>
      </h3>
      {!k.off && row("app")}
      {Object.keys(k.shortcuts).length > 0 && <button type="button" onClick={() => void save({})}>{L("הכל לברירת המחדל", "Everything back to the defaults")}</button>}
    </section>
  );
}

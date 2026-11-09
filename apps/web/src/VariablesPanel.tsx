import { useEffect, useState } from "react";
import { pinColor } from "./BlueprintCanvas";
import { getLocale } from "./i18n";
import { toast } from "./library";

const L = (he: string, en: string) => (getLocale() === "he" ? he : en);

/** A variable as the panel shows and edits it (a C# field, a Blueprint or graph variable). */
export interface PanelVar {
  name: string;
  type: string;
  /** The starting value, as plain text (5, true, Hello); the caller turns it into code. */
  value: string;
  /** Shown to the designer: Unity's Inspector, Unreal's Instance Editable. */
  shown: boolean;
  tooltip?: string;
  /** Unreal: the group it sits in. */
  category?: string;
  /** Shown but not changed here (const, static, several names on one line…). */
  locked?: boolean;
}

/** A type the variable can have. */
export interface PanelType {
  value: string;
  label: string;
  /** How its starting value is typed: a switch, a number, text, code, or not at all (set in the editor). */
  input: "bool" | "number" | "text" | "code" | "none";
  /** A group in the menu (Basic, Engine, This project). */
  group: string;
}

/** What the panel asks the page to do; each may throw (the reason is shown). */
export interface PanelActions {
  add: (v: PanelVar) => Promise<void> | void;
  change: (name: string, v: PanelVar) => Promise<void> | void;
  remove: (name: string) => Promise<void> | void;
  /** How many places use it (asked before removing). */
  uses?: (name: string) => number;
  /** Adds a step that sets it, in the open graph. */
  setInGraph?: (name: string) => void;
}

const ARRAY = /\[\]$/;

/** A type's short name for the list (Float, BP_Key, Vector3), not its code. */
const typeLabel = (types: PanelType[], t: string) => {
  const base = t.replace(ARRAY, "");
  const known = types.find((x) => x.value === base)?.label.replace(/\s*\(.*\)$/, "") ?? base.replace(/^\w+:/, "").replace(/^.*[/.]/, "");
  return ARRAY.test(t) ? `${known}[]` : known;
};

/**
 * The variables of a script or Blueprint, like the "My Blueprint" panel in
 * Unreal: a list with each variable's type color and an eye for whether the
 * designer sees it, a + to add one, and below it the chosen variable's
 * details (name, type, list or single, starting value, tooltip, shown).
 */
export function VariablesPanel(p: { vars: PanelVar[]; types: PanelType[]; actions: PanelActions; /** Without it there is no eye (Visual Scripting graph variables have no such setting). */ shownLabel?: string; categories?: boolean; busy?: boolean }) {
  const [sel, setSel] = useState("");
  const [adding, setAdding] = useState(false);
  const chosen = p.vars.find((v) => v.name === sel);
  const run = async (f: () => Promise<void> | void, then?: () => void) => {
    try {
      await f();
      then?.();
    } catch (e) {
      toast((e as Error).message);
    }
  };
  const newName = () => {
    for (let i = 1; ; i++) if (!p.vars.some((v) => v.name === `newVar${i}`)) return `newVar${i}`;
  };
  return (
    <div className="vars-panel">
      <div className="row vars-head">
        <strong className="grow">{L("משתנים", "Variables")}</strong>
        <button type="button" className="small" disabled={p.busy} onClick={() => setAdding((a) => !a)} aria-expanded={adding} title={L("משתנה חדש", "New variable")}>＋ {L("משתנה", "Variable")}</button>
      </div>
      {adding && (
        <VarForm
          key="new"
          v={{ name: newName(), type: p.types[0]?.value ?? "bool", value: "", shown: true }}
          types={p.types}
          shownLabel={p.shownLabel}
          categories={p.categories}
          submit={L("הוסף", "Add")}
          onSubmit={(v) => run(() => p.actions.add(v), () => { setAdding(false); setSel(v.name); })}
          onCancel={() => setAdding(false)}
        />
      )}
      {!p.vars.length && !adding ? <p className="muted small">{L("אין עדיין משתנים. ＋ מוסיף אחד.", "No variables yet. ＋ adds one.")}</p> : (
        <ul className="vars-list">
          {p.vars.map((v) => (
            <li key={v.name} className={v.name === sel ? "on" : ""}>
              <button type="button" className="vars-row" onClick={() => setSel(v.name === sel ? "" : v.name)} aria-expanded={v.name === sel} dir="ltr">
                <span className="vars-dot" style={{ background: pinColor(v.type.replace(ARRAY, "")) }} aria-hidden />
                <span className="grow vars-name">{v.name}{ARRAY.test(v.type) ? " [ ]" : ""}</span>
                <span className="muted vars-type" title={v.type}>{typeLabel(p.types, v.type)}</span>
              </button>
              {p.shownLabel && <button type="button" className="vars-eye" disabled={v.locked || p.busy} aria-pressed={v.shown} title={`${p.shownLabel}: ${v.shown ? L("כן", "yes") : L("לא", "no")}`} onClick={() => void run(() => p.actions.change(v.name, { ...v, shown: !v.shown }))}>{v.shown ? "👁" : "◌"}</button>}
            </li>
          ))}
        </ul>
      )}
      {chosen && (
        chosen.locked ? <p className="muted small">{L("את המשתנה הזה (const, static או כמה שמות בשורה אחת) משנים בקוד.", "Change this one (const, static or several names on one line) in the code.")}</p> : (
          <VarForm
            key={chosen.name}
            v={chosen}
            types={p.types}
            shownLabel={p.shownLabel}
            categories={p.categories}
            submit={L("שמור משתנה", "Save variable")}
            onSubmit={(v) => run(() => p.actions.change(chosen.name, v), () => setSel(v.name))}
            onRemove={() => {
              const n = p.actions.uses?.(chosen.name) ?? 0;
              if (n && !window.confirm(L(`המשתנה ${chosen.name} בשימוש ב-${n} מקומות. אחרי המחיקה הם לא יתקמפלו עד שתתקנו אותם. למחוק?`, `${chosen.name} is used in ${n} places; they will not compile until fixed. Remove it?`))) return;
              void run(() => p.actions.remove(chosen.name), () => setSel(""));
            }}
            onSetInGraph={p.actions.setInGraph ? () => p.actions.setInGraph!(chosen.name) : undefined}
          />
        )
      )}
    </div>
  );
}

/** The details of one variable (a new one or the chosen one). */
function VarForm(p: { v: PanelVar; types: PanelType[]; shownLabel?: string; categories?: boolean; submit: string; onSubmit: (v: PanelVar) => void; onCancel?: () => void; onRemove?: () => void; onSetInGraph?: () => void }) {
  const [v, setV] = useState(p.v);
  // Starts again only when the variable itself changed (a page that reloads often must not wipe what is typed).
  const was = JSON.stringify(p.v);
  useEffect(() => {
    setV(JSON.parse(was) as PanelVar);
  }, [was]);
  const list = ARRAY.test(v.type);
  const base = v.type.replace(ARRAY, "");
  const known = p.types.find((t) => t.value === base);
  const input = list ? "code" : known?.input ?? "code";
  const groups = [...new Set(p.types.map((t) => t.group))];
  const setType = (t: string, asList: boolean) => setV((x) => ({ ...x, type: asList ? `${t}[]` : t, value: "" }));
  const dirty = JSON.stringify(v) !== was;
  return (
    <form className="vars-form stack small" onSubmit={(e) => { e.preventDefault(); p.onSubmit({ ...v, name: v.name.trim() }); }}>
      <label className="stack">
        <span className="muted">{L("שם", "Name")}</span>
        <input dir="ltr" spellCheck={false} value={v.name} onChange={(e) => setV({ ...v, name: e.target.value.replace(/\s/g, "") })} required />
      </label>
      <div className="row wrap">
        <label className="stack grow">
          <span className="muted">{L("סוג", "Type")}</span>
          <select dir="ltr" value={base} onChange={(e) => setType(e.target.value, list)}>
            {!known && <option value={base}>{base}</option>}
            {groups.map((g) => (
              <optgroup key={g} label={g}>
                {p.types.filter((t) => t.group === g).map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
              </optgroup>
            ))}
          </select>
        </label>
        <label className="row vars-check">
          <input type="checkbox" checked={list} onChange={(e) => setType(base, e.target.checked)} />
          <span>{L("רשימה", "List")}</span>
        </label>
      </div>
      {input === "bool" ? (
        <label className="row vars-check">
          <input type="checkbox" checked={v.value === "true"} onChange={(e) => setV({ ...v, value: e.target.checked ? "true" : "false" })} />
          <span>{L("ערך התחלתי: אמת", "Starts as true")}</span>
        </label>
      ) : input === "none" ? (
        <p className="muted">{L("את הערך בוחרים בעורך (גוררים אובייקט לשדה).", "The value is picked in the editor (drag an object onto it).")}</p>
      ) : (
        <label className="stack">
          <span className="muted">{L("ערך התחלתי", "Starting value")}</span>
          <input dir="ltr" spellCheck={false} inputMode={input === "number" ? "decimal" : undefined} placeholder={input === "code" ? (list ? "new int[] { 1, 2 }" : base === "Vector3" ? "new Vector3(0, 1, 0)" : base === "Color" ? "Color.white" : "") : input === "number" ? "0" : ""} value={v.value} onChange={(e) => setV({ ...v, value: e.target.value })} />
        </label>
      )}
      {p.categories && (
        <label className="stack">
          <span className="muted">{L("קטגוריה", "Category")}</span>
          <input value={v.category ?? ""} onChange={(e) => setV({ ...v, category: e.target.value })} />
        </label>
      )}
      {p.shownLabel && (
        <label className="stack">
          <span className="muted">{L("הסבר (Tooltip)", "Tooltip")}</span>
          <input value={v.tooltip ?? ""} onChange={(e) => setV({ ...v, tooltip: e.target.value })} />
        </label>
      )}
      {p.shownLabel && (
        <label className="row vars-check">
          <input type="checkbox" checked={v.shown} onChange={(e) => setV({ ...v, shown: e.target.checked })} />
          <span>{p.shownLabel}</span>
        </label>
      )}
      <div className="row wrap">
        <button type="submit" className="primary" disabled={!dirty && !!p.onRemove}>{p.submit}</button>
        {p.onCancel && <button type="button" onClick={p.onCancel}>{L("ביטול", "Cancel")}</button>}
        {p.onSetInGraph && <button type="button" onClick={p.onSetInGraph} title={L("מוסיף צעד שמשנה את המשתנה", "Adds a step that changes it")}>＋ {L("צעד שמשנה אותו", "Step that sets it")}</button>}
        {p.onRemove && <button type="button" onClick={p.onRemove}>🗑 {L("מחק", "Remove")}</button>}
      </div>
    </form>
  );
}

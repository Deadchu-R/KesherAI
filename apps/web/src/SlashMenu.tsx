import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type TextareaHTMLAttributes } from "react";
import { api } from "./api";
import { fillPromptFields, promptFields, type PromptField } from "@kesher/shared";
import { getLocale, he$ } from "./i18n";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);

/** A saved prompt, as the server returns it. */
export interface SavedPrompt { id: string; command: string; title: string; text: string }

let cache: SavedPrompt[] | null = null;
const listeners = new Set<(p: SavedPrompt[]) => void>();

/** Reloads the prompt library everywhere it is used. */
export async function refreshPrompts(): Promise<SavedPrompt[]> {
  const r = await api<{ prompts: SavedPrompt[] }>("/api/prompts");
  cache = r.prompts;
  for (const l of listeners) l(r.prompts);
  return r.prompts;
}

/** @returns The prompt library (loads it once). */
export function usePrompts(): SavedPrompt[] {
  const [list, setList] = useState<SavedPrompt[]>(cache ?? []);
  useEffect(() => {
    listeners.add(setList);
    if (!cache) void refreshPrompts().catch(() => undefined);
    return () => void listeners.delete(setList);
  }, []);
  return list;
}

/**
 * Turns `/command rest` into the saved prompt, with `{{input}}` replaced by
 * the rest. Anything else comes back as it is.
 *
 * @param text - What the user is about to send.
 * @returns The message to send.
 */
export function expandSlash(text: string): string {
  const m = /^\/([^\s/]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  const p = m && cache?.find((x) => x.command === m[1]!.toLowerCase());
  if (!p) return text;
  const rest = (m[2] ?? "").trim();
  return p.text.includes("{{input}}") ? p.text.replaceAll("{{input}}", rest).trim() : rest ? `${p.text.trim()}\n\n${rest}` : p.text.trim();
}

/** What the `@` menu can offer: the chat's models (picking one switches the chat to it). */
export interface AtOptions {
  models?: Array<{ id: string; name: string }>;
  /** Switches the chat to a model. */
  onModel?: (id: string) => void;
  /** Sub-agents the lead agent hands the message to (`@name`); picking one writes `@name ` in the box. */
  agents?: Array<{ name: string; hint?: string }>;
}

/** A command the chat itself runs (`/compact`, `/fork`…), offered in the `/` menu before the saved prompts. */
export interface SlashCommand {
  command: string;
  title: string;
  /** It takes words after it (`/model qwen`): choosing it leaves the cursor after a space. */
  arg?: boolean;
}

type Props = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "value" | "onChange"> & { value: string; onValue: (v: string) => void; at?: AtOptions; commands?: SlashCommand[] };

/** One line of the `@` menu. */
interface AtItem { group: string; key: string; label: string; hint?: string; pick: () => void | Promise<void> }

/** Knowledge bases and pages for the `@` menu, loaded once per visit (they change rarely). */
let atLists: Promise<{ knowledge: Array<{ id: string; name: string }>; pages: Array<{ id: string; title?: string; name?: string }> }> | null = null;
const loadAtLists = () =>
  (atLists ??= Promise.all([
    api<{ bases: Array<{ id: string; name: string }> }>("/api/knowledge").then((r) => r.bases ?? [], () => []),
    api<Array<{ id: string; title?: string; name?: string }> | { pages: Array<{ id: string; title?: string; name?: string }> }>("/api/pages").then((r) => (Array.isArray(r) ? r : r.pages) ?? [], () => []),
  ]).then(([knowledge, pages]) => ({ knowledge, pages })));

/**
 * The word being typed after `@` at the end of the box (Claude, Cursor and Open WebUI's mention menu).
 *
 * @param value - The box's text.
 * @returns The text after `@` (may be empty), or undefined when the box does not end in an `@` word.
 */
export function atQuery(value: string): string | undefined {
  return /(?:^|\s)@([^\s@]{0,40})$/.exec(value)?.[1];
}

/**
 * A message box that offers the prompt library when the user types `/`:
 * arrows to choose, Enter or Tab to use one, Escape to close.
 */
export const PromptTextarea = forwardRef<HTMLTextAreaElement, Props>(function PromptTextarea({ value, onValue, onKeyDown, at, commands, ...rest }, outer) {
  const prompts = usePrompts();
  const ref = useRef<HTMLTextAreaElement>(null);
  useImperativeHandle(outer, () => ref.current!);
  const [active, setActive] = useState(0);
  const [closed, setClosed] = useState(false);
  const typed = /^\/([^\s]*)$/.exec(value)?.[1]?.toLowerCase();
  const matches = typed === undefined || closed ? [] : prompts.filter((p) => p.command.startsWith(typed) || p.title.toLowerCase().includes(typed)).slice(0, 8);
  // `@`: one menu for models, knowledge and pages (redesign 2026-11, audit F17).
  const atTyped = at && typed === undefined ? atQuery(value)?.toLowerCase() : undefined;
  const [lists, setLists] = useState<Awaited<ReturnType<typeof loadAtLists>> | null>(null);
  useEffect(() => {
    if (atTyped !== undefined && !lists) void loadAtLists().then(setLists);
  }, [atTyped, lists]);
  const without = () => value.replace(/@[^\s@]*$/, "");
  const atItems: AtItem[] = atTyped === undefined || closed ? [] : [
    ...(at?.agents ?? []).map((a) => ({ group: L("סוכנים: הסוכן הראשי מעביר להם", "Agents: the lead agent hands it over"), key: `a:${a.name}`, label: `@${a.name}`, ...(a.hint ? { hint: a.hint } : {}), pick: () => onValue(`${without()}@${a.name} `) })),
    ...(at?.models ?? []).map((m) => ({ group: L("מודלים: הצ׳אט עובר אליו", "Models: the chat switches to it"), key: `m:${m.id}`, label: m.name, pick: () => { onValue(without()); at?.onModel?.(m.id); } })),
    ...(lists?.knowledge ?? []).map((k) => ({ group: L("ידע", "Knowledge"), key: `k:${k.id}`, label: k.name, pick: () => onValue(`${without()}${L("חפש בבסיס הידע", "Search the knowledge base")} "${k.name}": `) })),
    ...(lists?.pages ?? []).map((pg) => ({ group: L("דפים", "Pages"), key: `p:${pg.id}`, label: pg.title ?? pg.name ?? pg.id, pick: async () => {
      const page = await api<{ title?: string; content?: string }>(`/api/pages/${encodeURIComponent(pg.id)}`).catch(() => null);
      const text = (page?.content ?? "").slice(0, 6000);
      onValue(`${without()}[${L("דף", "Page")}: ${pg.title ?? pg.name ?? pg.id}]\n${text}${(page?.content?.length ?? 0) > 6000 ? "\n…" : ""}\n`);
    } })),
  ].filter((x) => !atTyped || x.label.toLowerCase().includes(atTyped)).filter((x, i, all) => all.slice(0, i).filter((y) => y.group === x.group).length < 4);
  // The chat's own commands first, then the saved prompts (as Open WebUI's and Claude Code's `/` menu).
  const items: Array<{ key: string; command: string; title: string; builtin: boolean; pick: () => void }> = typed === undefined || closed ? [] : [
    ...(commands ?? []).filter((c) => c.command.startsWith(typed)).map((c) => ({ key: `b:${c.command}`, command: c.command, title: c.title, builtin: true, pick: () => onValue(`/${c.command}${c.arg ? " " : ""}`) })),
    ...matches.map((p) => ({ key: p.id, command: p.command, title: p.title, builtin: false, pick: () => applyPrompt(p) })),
  ];
  const open = typed !== undefined && !closed && (items.length > 0 || prompts.length === 0);
  const atOpen = atTyped !== undefined && !closed;
  useEffect(() => {
    setActive(0);
  }, [typed, atTyped]);
  useEffect(() => {
    if (typed === undefined && atTyped === undefined) setClosed(false);
  }, [typed, atTyped]);

  // A prompt with fields ({{name}}, {{tone | select:…}}) asks for them first, in a small form above the box.
  const [fill, setFill] = useState<{ text: string; title: string; fields: PromptField[]; values: Record<string, string | boolean> } | null>(null);
  const insertPrompt = (text: string) => {
    const at = text.indexOf("{{input}}");
    const next = at >= 0 ? text.replace("{{input}}", "") : `${text.trim()}\n\n`;
    caret.current = at >= 0 ? at : next.length;
    onValue(next);
  };
  const applyPrompt = (p: SavedPrompt) => {
    const fields = promptFields(p.text);
    if (!fields.length) return insertPrompt(p.text);
    onValue("");
    setFill({ text: p.text, title: p.title, fields, values: Object.fromEntries(fields.map((f) => [f.name, f.type === "checkbox" ? false : (f.default ?? "")])) });
  };
  const fillMissing = fill?.fields.filter((f) => f.required && f.type !== "checkbox" && !String(fill.values[f.name] ?? "").trim()) ?? [];
  // Put the cursor where {{input}} was, as soon as the new text is in the box.
  const caret = useRef<number | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (caret.current === null || !el) return;
    el.focus();
    el.setSelectionRange(caret.current, caret.current);
    caret.current = null;
  }, [value]);

  return (
    <div className="slash-wrap">
      {fill && (
        <form
          className="card prompt-fields"
          aria-label={fill.title}
          onSubmit={(e) => {
            e.preventDefault();
            if (fillMissing.length) return;
            insertPrompt(fillPromptFields(fill.text, fill.values));
            setFill(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") setFill(null);
          }}
        >
          <b className="small" dir="auto">{fill.title}</b>
          {fill.fields.map((f, i) => {
            const set = (v: string | boolean) => setFill({ ...fill, values: { ...fill.values, [f.name]: v } });
            const v = fill.values[f.name];
            const label = <span className="small" dir="auto">{f.type === "checkbox" ? null : f.name}{f.required ? " *" : ""}</span>;
            if (f.type === "checkbox") return <label key={f.name} className="row small"><input type="checkbox" checked={v === true} onChange={(e) => set(e.target.checked)} /> <span dir="auto">{f.label ?? f.name}</span></label>;
            if (f.type === "select") return <label key={f.name} className="prompt-field">{label}<select autoFocus={i === 0} value={String(v ?? "")} onChange={(e) => set(e.target.value)}>{!f.required && <option value="">—</option>}{f.options!.map((o) => <option key={o} value={o}>{o}</option>)}</select></label>;
            if (f.type === "textarea") return <label key={f.name} className="prompt-field">{label}<textarea autoFocus={i === 0} rows={3} dir="auto" value={String(v ?? "")} placeholder={f.placeholder} onChange={(e) => set(e.target.value)} /></label>;
            return <label key={f.name} className="prompt-field">{label}<input autoFocus={i === 0} dir="auto" type={f.type === "number" ? "number" : f.type === "date" ? "date" : "text"} min={f.min} max={f.max} value={String(v ?? "")} placeholder={f.placeholder} onChange={(e) => set(e.target.value)} /></label>;
          })}
          <div className="row">
            <button type="submit" className="primary small" disabled={fillMissing.length > 0}>{L("הכנס", "Insert")}</button>
            <button type="button" className="ghost small" onClick={() => setFill(null)}>{L("ביטול", "Cancel")}</button>
          </div>
        </form>
      )}
      {open && (
        <div className="slash-menu" role="listbox" aria-label={L("פרומפטים שמורים", "Saved prompts")}>
          {items.map((p, i) => (
            <button
              key={p.key}
              type="button"
              role="option"
              aria-selected={i === active}
              className={`${i === active ? "on" : ""}${p.builtin ? " slash-builtin" : ""}`}
              onMouseDown={(e) => { e.preventDefault(); p.pick(); }}
              onMouseEnter={() => setActive(i)}
            >
              <span className="slash-cmd" dir="ltr">/{p.command}</span>
              <span className="muted small" dir="auto">{p.title}</span>
            </button>
          ))}
          {!prompts.length && <a className="slash-empty muted small" href="#/prompts">{L("עוד אין פרומפטים שמורים — הוסיפו כאן", "No saved prompts yet — add some here")}</a>}
          {!!prompts.length && <a className="slash-empty muted small" href="#/prompts">{L("ניהול פרומפטים…", "Manage prompts…")}</a>}
        </div>
      )}
      {atOpen && (
        <div className="slash-menu at-menu" role="listbox" aria-label={L("צירוף או מודל", "Attach or address")}>
          {atItems.map((x, i) => (
            <div key={x.key} className="at-item">
              {(i === 0 || atItems[i - 1]!.group !== x.group) && <span className="at-group muted small">{x.group}</span>}
              <button
                type="button"
                role="option"
                aria-selected={i === active}
                className={i === active ? "on" : ""}
                onMouseDown={(e) => { e.preventDefault(); void x.pick(); }}
                onMouseEnter={() => setActive(i)}
              >
                <span dir="auto">{x.label}</span>
              </button>
            </div>
          ))}
          {!atItems.length && <span className="slash-empty muted small">{lists ? L("אין התאמה", "Nothing matches") : L("טוען…", "Loading…")}</span>}
          <span className="at-keys muted small">{L("↑↓ בחירה · Enter צירוף · Esc סגירה", "↑↓ choose · Enter attach · Esc close")}</span>
        </div>
      )}
      <textarea
        ref={ref}
        value={value}
        onChange={(e) => onValue(e.target.value)}
        onKeyDown={(e) => {
          if (atOpen && atItems.length) {
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              setActive((a) => (a + (e.key === "ArrowDown" ? 1 : atItems.length - 1)) % atItems.length);
              return;
            }
            if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") {
              e.preventDefault();
              void atItems[Math.min(active, atItems.length - 1)]!.pick();
              return;
            }
          }
          if (atOpen && e.key === "Escape") {
            e.preventDefault();
            setClosed(true);
            return;
          }
          if (open && items.length) {
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              setActive((a) => (a + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length);
              return;
            }
            // A command typed out in full runs on Enter (`/compact`), instead of being picked again from the menu.
            const exact = items[active]!.builtin && value.trim() === `/${items[active]!.command}`;
            if (((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") && !(exact && e.key === "Enter")) {
              e.preventDefault();
              items[Math.min(active, items.length - 1)]!.pick();
              return;
            }
          }
          if (open && e.key === "Escape") {
            e.preventDefault();
            setClosed(true);
            return;
          }
          onKeyDown?.(e);
        }}
        {...rest}
      />
    </div>
  );
});

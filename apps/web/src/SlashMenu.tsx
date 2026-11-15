import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type TextareaHTMLAttributes } from "react";
import { api } from "./api";
import { getLocale } from "./i18n";

const L = (he: string, en: string) => (getLocale() === "he" ? he : en);

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
}

type Props = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "value" | "onChange"> & { value: string; onValue: (v: string) => void; at?: AtOptions };

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
export const PromptTextarea = forwardRef<HTMLTextAreaElement, Props>(function PromptTextarea({ value, onValue, onKeyDown, at, ...rest }, outer) {
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
    ...(at?.models ?? []).map((m) => ({ group: L("מודלים: הצ׳אט עובר אליו", "Models: the chat switches to it"), key: `m:${m.id}`, label: m.name, pick: () => { onValue(without()); at?.onModel?.(m.id); } })),
    ...(lists?.knowledge ?? []).map((k) => ({ group: L("ידע", "Knowledge"), key: `k:${k.id}`, label: k.name, pick: () => onValue(`${without()}${L("חפש בבסיס הידע", "Search the knowledge base")} "${k.name}": `) })),
    ...(lists?.pages ?? []).map((pg) => ({ group: L("דפים", "Pages"), key: `p:${pg.id}`, label: pg.title ?? pg.name ?? pg.id, pick: async () => {
      const page = await api<{ title?: string; content?: string }>(`/api/pages/${encodeURIComponent(pg.id)}`).catch(() => null);
      const text = (page?.content ?? "").slice(0, 6000);
      onValue(`${without()}[${L("דף", "Page")}: ${pg.title ?? pg.name ?? pg.id}]\n${text}${(page?.content?.length ?? 0) > 6000 ? "\n…" : ""}\n`);
    } })),
  ].filter((x) => !atTyped || x.label.toLowerCase().includes(atTyped)).filter((x, i, all) => all.slice(0, i).filter((y) => y.group === x.group).length < 4);
  const open = typed !== undefined && !closed && (matches.length > 0 || prompts.length === 0);
  const atOpen = atTyped !== undefined && !closed;
  useEffect(() => {
    setActive(0);
  }, [typed, atTyped]);
  useEffect(() => {
    if (typed === undefined && atTyped === undefined) setClosed(false);
  }, [typed, atTyped]);

  const use = (p: SavedPrompt) => {
    const at = p.text.indexOf("{{input}}");
    const next = at >= 0 ? p.text.replace("{{input}}", "") : `${p.text.trim()}\n\n`;
    caret.current = at >= 0 ? at : next.length;
    onValue(next);
  };
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
      {open && (
        <div className="slash-menu" role="listbox" aria-label={L("פרומפטים שמורים", "Saved prompts")}>
          {matches.map((p, i) => (
            <button
              key={p.id}
              type="button"
              role="option"
              aria-selected={i === active}
              className={i === active ? "on" : ""}
              onMouseDown={(e) => { e.preventDefault(); use(p); }}
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
          if (open && matches.length) {
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              setActive((a) => (a + (e.key === "ArrowDown" ? 1 : matches.length - 1)) % matches.length);
              return;
            }
            if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") {
              e.preventDefault();
              use(matches[active]!);
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

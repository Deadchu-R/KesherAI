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

type Props = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "value" | "onChange"> & { value: string; onValue: (v: string) => void };

/**
 * A message box that offers the prompt library when the user types `/`:
 * arrows to choose, Enter or Tab to use one, Escape to close.
 */
export const PromptTextarea = forwardRef<HTMLTextAreaElement, Props>(function PromptTextarea({ value, onValue, onKeyDown, ...rest }, outer) {
  const prompts = usePrompts();
  const ref = useRef<HTMLTextAreaElement>(null);
  useImperativeHandle(outer, () => ref.current!);
  const [active, setActive] = useState(0);
  const [closed, setClosed] = useState(false);
  const typed = /^\/([^\s]*)$/.exec(value)?.[1]?.toLowerCase();
  const matches = typed === undefined || closed ? [] : prompts.filter((p) => p.command.startsWith(typed) || p.title.toLowerCase().includes(typed)).slice(0, 8);
  const open = typed !== undefined && !closed && (matches.length > 0 || prompts.length === 0);
  useEffect(() => {
    setActive(0);
  }, [typed]);
  useEffect(() => {
    if (typed === undefined) setClosed(false);
  }, [typed]);

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
      <textarea
        ref={ref}
        value={value}
        onChange={(e) => onValue(e.target.value)}
        onKeyDown={(e) => {
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

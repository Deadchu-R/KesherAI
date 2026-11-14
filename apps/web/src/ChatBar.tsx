import { useEffect, useState } from "react";
import { api } from "./api";
import { getLocale } from "./i18n";
import { toast } from "./library";
import { BarPopover } from "./ui/BarPopover";

const L = (he: string, en: string) => (getLocale() === "he" ? he : en);

/**
 * The buttons a chat's bar can show, and which show when nothing was chosen (found by Roee's brother: too many
 * buttons in a chat). Settings → Chats sets the default for every chat; a chat's ⚙ changes its own.
 */
export const BAR_BUTTONS: Array<{ key: string; he: string; en: string; on: (kind: string) => boolean }> = [
  { key: "steps", he: "שלבים", en: "Steps", on: () => true },
  { key: "browser", he: "דפדפן", en: "Browser", on: () => true },
  { key: "files", he: "קבצים", en: "Files", on: () => true },
  { key: "workspace", he: "סביבת עבודה (קוד)", en: "Workspace (code)", on: (kind) => kind === "code" },
  { key: "team", he: "צוות מודלים", en: "Model team", on: () => false },
  { key: "group", he: "קבוצת פרסונות", en: "Persona group", on: () => false },
  { key: "coach", he: "מאמן", en: "Coach", on: () => false },
  { key: "context", he: "הקשר", en: "Context", on: () => false },
  { key: "blueprint", he: "Blueprint (כשמחובר Unreal)", en: "Blueprint (with Unreal connected)", on: () => true },
  { key: "plugins", he: "חלוניות של תוספים", en: "Plugin panes", on: () => true },
];

let defaults: Record<string, boolean> | null = null;
const listeners = new Set<(d: Record<string, boolean>) => void>();

/** Settings' default for every chat's bar (read once, shared). */
export function useBarDefaults(): Record<string, boolean> {
  const [d, setD] = useState<Record<string, boolean>>(defaults ?? {});
  useEffect(() => {
    listeners.add(setD);
    if (!defaults) void api<Record<string, boolean>>("/api/chat-bar").then((x) => ((defaults = x), listeners.forEach((l) => l(x))), () => undefined);
    return () => void listeners.delete(setD);
  }, []);
  return d;
}

/** Saves Settings' default for every chat. */
export function saveBarDefaults(next: Record<string, boolean>): Promise<void> {
  return api<Record<string, boolean>>("/api/chat-bar", { method: "PUT", body: next }).then((x) => {
    defaults = x;
    listeners.forEach((l) => l(x));
  });
}

/**
 * Whether a chat's bar shows a button: the chat's own choice, else Settings' default, else the built-in one.
 *
 * @param key - The button.
 * @param kind - The chat's kind ("chat", "code").
 */
export function barShows(key: string, kind: string, chat: Record<string, boolean> | undefined, global: Record<string, boolean>): boolean {
  return chat?.[key] ?? global[key] ?? BAR_BUTTONS.find((b) => b.key === key)?.on(kind) ?? true;
}

/** This chat's ⚙: tick the buttons its bar shows; "for every chat" makes it Settings' default. */
export function ChatBarButton({ kind, bar, onChange }: { kind: string; bar: Record<string, boolean> | undefined; onChange: (bar: Record<string, boolean> | null) => void }) {
  const global = useBarDefaults();
  return (
    <BarPopover icon={<span aria-hidden="true">⚙</span>} label={L("הגדרות הצ'אט", "Chat settings")} title={L("אילו כפתורים יופיעו בצ'אט הזה", "Which buttons this chat shows")} className="chat-bar-btn">
      {() => (
        <div className="stack chat-bar-form" role="group" aria-label={L("כפתורים בצ'אט הזה", "Buttons in this chat")}>
          <strong>{L("כפתורים בצ'אט הזה", "Buttons in this chat")}</strong>
          {BAR_BUTTONS.map((b) => (
            <label key={b.key} className="check small">
              <input type="checkbox" checked={barShows(b.key, kind, bar, global)} onChange={(e) => onChange({ ...(bar ?? {}), [b.key]: e.target.checked })} />
              {L(b.he, b.en)}
            </label>
          ))}
          <div className="row wrap">
            <button type="button" className="small" onClick={() => void saveBarDefaults(Object.fromEntries(BAR_BUTTONS.map((b) => [b.key, barShows(b.key, kind, bar, global)]))).then(() => { onChange(null); toast(L("זו ברירת המחדל לכל הצ'אטים עכשיו.", "This is now the default for every chat.")); }, (e: Error) => toast(e.message))}>{L("לכל הצ'אטים", "For every chat")}</button>
            {bar && <button type="button" className="small" onClick={() => onChange(null)}>{L("כמו ברירת המחדל", "Like the default")}</button>}
          </div>
          <span className="muted small">{L("ברירת המחדל: הגדרות ← צ'אטים. חלונית פתוחה נשארת עם הכפתור שלה.", "The default: Settings → Chats. An open pane keeps its button.")}</span>
        </div>
      )}
    </BarPopover>
  );
}

/** Settings → Chats: the buttons every chat's bar shows (each chat can change its own with its ⚙). */
export function ChatBarSection() {
  const global = useBarDefaults();
  return (
    <section className="card stack">
      <h2>{L("כפתורים בצ'אט", "Buttons in a chat")}</h2>
      <p className="muted">{L("מה יופיע בסרגל של כל צ'אט. בכל צ'אט אפשר לשנות לעצמו דרך ⚙.", "What every chat's bar shows. Each chat can change its own with ⚙.")}</p>
      {BAR_BUTTONS.map((b) => (
        <label key={b.key} className="check">
          <input type="checkbox" checked={global[b.key] ?? b.on("chat")} onChange={(e) => void saveBarDefaults({ ...global, [b.key]: e.target.checked }).catch((err: Error) => toast(err.message))} />
          {L(b.he, b.en)}
        </label>
      ))}
    </section>
  );
}

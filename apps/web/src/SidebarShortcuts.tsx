/**
 * The user's own shortcuts at the top of the sidebar (after Notion's sidebar shortcuts): ⭐ adds the page that is
 * open now; each one can be renamed, given an emoji, moved or removed (removing only takes it off the sidebar).
 * Kept on the computer (/api/shortcuts), so the phone shows the same ones. A web address opens outside the app.
 */
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { askText } from "./ui/askText";
import { api } from "./api";
import { getLocale } from "./i18n";
import { toast } from "./library";
import { NAV_ICONS, useNavItems } from "./Sidebar";
import { Menu, MenuItem, MenuSeparator } from "./ui/Menu";

const L = (he: string, en: string) => (getLocale() === "he" ? he : en);

/** A shortcut. */
export interface Shortcut { id: string; label: string; icon?: string; image?: string; href: string }

let cache: Shortcut[] | null = null;
const listeners = new Set<(s: Shortcut[]) => void>();
/** Shows shortcuts that were changed on the computer (the design assistant's change_menu). */
export function showShortcuts(next: Shortcut[]): void {
  cache = next;
  listeners.forEach((l) => l(next));
}
/** Saves the whole list (add, rename, reorder and remove are one save). */
export const saveShortcuts = (next: Shortcut[]) => save(next);
const save = (next: Shortcut[]) =>
  api<{ shortcuts: Shortcut[] }>("/api/shortcuts", { method: "PUT", body: { shortcuts: next } }).then(
    (r) => {
      cache = r.shortcuts;
      listeners.forEach((l) => l(r.shortcuts));
    },
    (e: Error) => toast(e.message),
  );

/** The user's shortcuts, one list for every menu (the sidebar, the top bar's menu), kept on the computer. */
export function useShortcuts(): Shortcut[] {
  const [list, setList] = useState<Shortcut[]>(cache ?? []);
  useEffect(() => {
    listeners.add(setList);
    if (!cache) void api<{ shortcuts: Shortcut[] }>("/api/shortcuts").then((r) => ((cache = r.shortcuts), listeners.forEach((l) => l(r.shortcuts))), () => undefined);
    return () => void listeners.delete(setList);
  }, []);
  return list;
}

/** The shortcuts and the + button. */
export function SidebarShortcuts({ hash }: { hash: string }) {
  const list = useShortcuts();
  const nav = useNavItems();
  // The page open now, named like the sidebar names it (or the window's title).
  const addHere = () => {
    const href = hash || "#/";
    if (list.some((s) => s.href === href)) return toast(L("הדף הזה כבר בקיצורי הדרך", "This page is already a shortcut"));
    const known = nav.find((n) => n.href === href);
    const label = (known?.label ?? document.title.replace(/\s*[-–|·]\s*KesherAI.*$/i, "").trim() ?? "").slice(0, 40) || L("קיצור דרך", "Shortcut");
    void save([...list, { id: "", label, icon: NAV_ICONS[href] ?? "⭐", href }]).then(() => toast(L(`נוסף לסרגל הצד: ${label}`, `Added to the sidebar: ${label}`)));
  };
  // The form for a new shortcut or for changing one (index), and the "describe it in words" request.
  const [form, setForm] = useState<{ i: number; s: Shortcut } | null>(null);
  const [asking, setAsking] = useState(false);
  const addLink = () => setForm({ i: -1, s: { id: "", label: "", icon: "🔗", href: "https://" } });
  const describe = async () => {
    setAsking(true);
    await describeShortcut(nav).finally(() => setAsking(false));
  };
  const move = (i: number, by: number) => {
    const next = [...list];
    const [x] = next.splice(i, 1);
    next.splice(Math.max(0, Math.min(next.length, i + by)), 0, x!);
    void save(next);
  };
  return (
    <div className="nav-shortcuts">
      <div className="section-head">
        <span>{L("קיצורי דרך", "Shortcuts")}</span>
        <Menu trigger="+" triggerClassName="icon-btn" aria-label={L("הוסף קיצור דרך", "Add a shortcut")} title={L("הוסף קיצור דרך", "Add a shortcut")}>
          <MenuItem icon="⭐" onSelect={addHere}>{L("הדף הפתוח עכשיו", "The page open now")}</MenuItem>
          <MenuItem icon="🔗" onSelect={addLink}>{L("כתובת או דף אחר…", "An address or another page…")}</MenuItem>
          <MenuItem icon="✨" onSelect={() => void describe()}>{asking ? L("ה-AI עובד…", "The AI is working…") : L("לתאר במילים ל-AI…", "Describe it to the AI…")}</MenuItem>
        </Menu>
      </div>
      {list.map((s, i) => {
        const web = /^https?:/i.test(s.href);
        return (
          <div key={s.id} className="nav-shortcut">
            <a className="nav-link" href={s.href} {...(web ? { target: "_blank", rel: "noopener noreferrer" } : {})} aria-current={!web && hash === s.href ? "page" : undefined}>
              <span className="nav-ico" aria-hidden="true">{s.image ? <img src={s.image} alt="" width={16} height={16} /> : s.icon ?? "⭐"}</span> <span dir="auto">{s.label}</span>{web && <span className="muted small" aria-hidden="true"> ↗</span>}
            </a>
            <Menu trigger="⋯" triggerClassName="icon-btn nav-shortcut-more" aria-label={L(`אפשרויות: ${s.label}`, `Options: ${s.label}`)}>
              <MenuItem icon="✏" onSelect={() => setForm({ i, s })}>{L("עריכה (שם, כתובת, אייקון)", "Edit (name, address, icon)")}</MenuItem>
              {i > 0 && <MenuItem icon="↑" onSelect={() => move(i, -1)}>{L("למעלה", "Up")}</MenuItem>}
              {i < list.length - 1 && <MenuItem icon="↓" onSelect={() => move(i, 1)}>{L("למטה", "Down")}</MenuItem>}
              <MenuSeparator />
              <MenuItem icon="✕" danger onSelect={() => void save(list.filter((_, j) => j !== i))}>{L("הסר מסרגל הצד", "Remove from the sidebar")}</MenuItem>
            </Menu>
          </div>
        );
      })}
      {form &&
        createPortal(
          <ShortcutForm
            initial={form.s}
            onClose={() => setForm(null)}
            onSave={(next) => {
              void save(form.i < 0 ? [...list, next] : list.map((x, j) => (j === form.i ? next : x)));
              setForm(null);
            }}
          />,
          document.body,
        )}
    </div>
  );
}

/**
 * A shortcut described in words: the design assistant adds it (and can fetch the site's own icon).
 *
 * @param nav - The app's pages (so it can make a shortcut to one of them).
 */
export async function describeShortcut(nav: Array<{ href: string; label: string }>): Promise<void> {
  const text = (await askText(L("איזה קיצור דרך? (למשל: יוטיוב עם האייקון של האתר)", "Which shortcut? (e.g. YouTube with the site's own icon)")))?.trim();
  if (!text) return;
  toast(L("ה-AI מוסיף את קיצור הדרך…", "The AI is adding the shortcut…"));
  try {
    const r = await api<{ reply: string; menu: boolean; shortcuts: Shortcut[] }>("/api/design-assistant", { method: "POST", body: { text: `Shortcuts in the side menu: ${text}`, pages: nav.map((n) => ({ href: n.href, label: n.label })), hebrew: getLocale() === "he" } });
    if (r.menu) showShortcuts(r.shortcuts);
    toast(r.reply || L("בוצע.", "Done."));
  } catch (e) {
    toast((e as Error).message);
  }
}

const EMOJIS = ["⭐", "🔗", "📁", "💬", "🎮", "🎨", "📝", "📚", "🛠", "🎵", "📺", "🧠"];

/** A shortcut's name, address and icon: an emoji, or the site's own icon fetched from it. */
export function ShortcutForm({ initial, onSave, onClose }: { initial: Shortcut; onSave: (s: Shortcut) => void; onClose: () => void }) {
  const [s, setS] = useState(initial);
  const [fetching, setFetching] = useState(false);
  const web = /^https?:\/\/[^/\s]+\.[^/\s]+/i.test(s.href);
  const fetchIcon = () => {
    setFetching(true);
    void api<{ image: string }>("/api/shortcuts/site-icon", { method: "POST", body: { url: s.href } })
      .then((r) => setS({ ...s, image: r.image }), (e: Error) => toast(e.message))
      .finally(() => setFetching(false));
  };
  return (
    <div className="dialog-backdrop on-top" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="dialog card stack shortcut-form" role="dialog" aria-modal="true" aria-label={L("קיצור דרך", "Shortcut")} onSubmit={(e) => { e.preventDefault(); if (s.label.trim() && s.href.trim()) onSave({ ...s, label: s.label.trim(), href: s.href.trim() }); }} onKeyDown={(e) => e.key === "Escape" && onClose()}>
        <strong>{initial.label ? L("עריכת קיצור דרך", "Edit shortcut") : L("קיצור דרך חדש", "New shortcut")}</strong>
        <label className="stack small">{L("שם", "Name")}<input autoFocus dir="auto" value={s.label} onChange={(e) => setS({ ...s, label: e.target.value })} /></label>
        <label className="stack small">{L("כתובת (https://…) או דף של KesherAI (#/…)", "An address (https://…) or a KesherAI page (#/…)")}<input dir="ltr" value={s.href} onChange={(e) => setS({ ...s, href: e.target.value })} /></label>
        <div className="stack small">
          <span>{L("אייקון", "Icon")}</span>
          <div className="row wrap shortcut-icons">
            {s.image && <button type="button" className="on" title={L("האייקון של האתר (לחיצה מסירה)", "The site's icon (click to remove)")} onClick={() => setS({ ...s, image: undefined })}><img src={s.image} alt="" width={18} height={18} /></button>}
            {EMOJIS.map((em) => <button key={em} type="button" className={!s.image && s.icon === em ? "on" : ""} onClick={() => setS({ ...s, icon: em, image: undefined })}>{em}</button>)}
            <input className="shortcut-emoji" aria-label={L("אמוג'י אחר", "Another emoji")} placeholder="😀" value={s.image || EMOJIS.includes(s.icon ?? "") ? "" : s.icon ?? ""} onChange={(e) => setS({ ...s, icon: [...e.target.value.trim()].slice(-2).join("") || "⭐", image: undefined })} />
          </div>
          {web && <button type="button" style={{ alignSelf: "start" }} disabled={fetching} onClick={fetchIcon}>{fetching ? L("מביא…", "Fetching…") : L("🌐 האייקון של האתר", "🌐 The site's own icon")}</button>}
        </div>
        <div className="row">
          <button type="submit" className="primary" disabled={!s.label.trim() || !s.href.trim()}>{L("שמור", "Save")}</button>
          <button type="button" onClick={onClose}>{L("ביטול", "Cancel")}</button>
        </div>
      </form>
    </div>
  );
}

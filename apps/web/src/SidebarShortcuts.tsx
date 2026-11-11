/**
 * The user's own shortcuts at the top of the sidebar (after Notion's sidebar shortcuts): ⭐ adds the page that is
 * open now; each one can be renamed, given an emoji, moved or removed (removing only takes it off the sidebar).
 * Kept on the computer (/api/shortcuts), so the phone shows the same ones. A web address opens outside the app.
 */
import { useEffect, useState } from "react";
import { api } from "./api";
import { getLocale } from "./i18n";
import { toast } from "./library";
import { NAV_ICONS, useNavItems } from "./Sidebar";
import { Menu, MenuItem, MenuSeparator } from "./ui/Menu";

const L = (he: string, en: string) => (getLocale() === "he" ? he : en);

/** A shortcut. */
export interface Shortcut { id: string; label: string; icon?: string; href: string }

let cache: Shortcut[] | null = null;
const listeners = new Set<(s: Shortcut[]) => void>();
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
  const addLink = () => {
    const href = prompt(L("כתובת (https://…) או דף של KesherAI (#/…)", "An address (https://…) or a KesherAI page (#/…)"))?.trim();
    if (!href) return;
    const label = prompt(L("שם לקיצור הדרך", "A name for the shortcut"))?.trim();
    if (label) void save([...list, { id: "", label, icon: href.startsWith("http") ? "🔗" : "⭐", href }]);
  };
  const edit = (i: number, change: Partial<Shortcut>) => void save(list.map((s, j) => (j === i ? { ...s, ...change } : s)));
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
        </Menu>
      </div>
      {list.map((s, i) => {
        const web = /^https?:/i.test(s.href);
        return (
          <div key={s.id} className="nav-shortcut">
            <a className="nav-link" href={s.href} {...(web ? { target: "_blank", rel: "noopener noreferrer" } : {})} aria-current={!web && hash === s.href ? "page" : undefined}>
              <span className="nav-ico" aria-hidden="true">{s.icon ?? "⭐"}</span> <span dir="auto">{s.label}</span>{web && <span className="muted small" aria-hidden="true"> ↗</span>}
            </a>
            <Menu trigger="⋯" triggerClassName="icon-btn nav-shortcut-more" aria-label={L(`אפשרויות: ${s.label}`, `Options: ${s.label}`)}>
              <MenuItem icon="✏" onSelect={() => { const v = prompt(L("שם חדש", "New name"), s.label)?.trim(); if (v) edit(i, { label: v }); }}>{L("שינוי שם", "Rename")}</MenuItem>
              <MenuItem icon="😀" onSelect={() => { const v = prompt(L("אמוג'י (אחד)", "An emoji (one)"), s.icon ?? "")?.trim(); if (v !== undefined) edit(i, { icon: v || "⭐" }); }}>{L("אמוג'י", "Emoji")}</MenuItem>
              {i > 0 && <MenuItem icon="↑" onSelect={() => move(i, -1)}>{L("למעלה", "Up")}</MenuItem>}
              {i < list.length - 1 && <MenuItem icon="↓" onSelect={() => move(i, 1)}>{L("למטה", "Down")}</MenuItem>}
              <MenuSeparator />
              <MenuItem icon="✕" danger onSelect={() => void save(list.filter((_, j) => j !== i))}>{L("הסר מסרגל הצד", "Remove from the sidebar")}</MenuItem>
            </Menu>
          </div>
        );
      })}
    </div>
  );
}

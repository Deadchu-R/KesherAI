import { useEffect, useRef, useState } from "react";
import { getLocale, he$, t } from "./i18n";
import { useActivity, useLibrary } from "./library";
import { NAV_ICONS } from "./nav-icons";
import { useNavItems } from "./Sidebar";
import { useAppearance } from "./appearance";
import { HOME, closeTab, openTab, pinTab, placeOf, readTabs, stepTab, type PageTab } from "./tabs-state";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);
const KEY = "kesher-tabs";

const save = (tabs: PageTab[]) => {
  try {
    localStorage.setItem(KEY, JSON.stringify(tabs));
  } catch {
    // this visit only
  }
};
const load = (): PageTab[] => {
  try {
    return readTabs(localStorage.getItem(KEY));
  } catch {
    return [];
  }
};

/** A tab's icon and title: a chat's own title, a menu page's name, or the address. */
function useTitles(): (hash: string) => { icon: string; title: string; chatId?: string } {
  const { conversations } = useLibrary();
  const nav = useNavItems();
  return (hash) => {
    const place = placeOf(hash);
    const chat = /^#\/c\/([\w-]+)/.exec(place)?.[1];
    if (chat) {
      const c = conversations.find((x) => x.id === chat);
      return { icon: c?.kind === "code" ? "</>" : "💬", title: c?.title || L("צ'אט", "Chat"), chatId: chat };
    }
    const page = nav.find((n) => place === n.href || place.startsWith(`${n.href}/`));
    if (page) return { icon: NAV_ICONS[page.href] ?? "•", title: page.label };
    if (place.startsWith("#/settings")) return { icon: "⚙", title: t("settings") };
    if (place === "#/apps") return { icon: "▦", title: t("allTools") };
    return { icon: "•", title: decodeURIComponent(place.slice(2)).slice(0, 40) };
  };
}

/**
 * Tabs for the open pages (design TabsImageEditor): Home first, then chats, editors, documents and pages. Going
 * somewhere new opens a preview tab (in italics) that the next place replaces; a double click keeps it. A dot shows
 * while a chat answers. Ctrl+Tab and Ctrl+Shift+Tab go round them, a middle click closes one. On a phone (narrow
 * screens) the row becomes a counter that opens the open tabs as cards. Off in Settings → Appearance.
 *
 * @param props.hash - The address showing now.
 */
export function PageTabs({ hash }: { hash: string }) {
  const off = useAppearance().pageTabs === false;
  const [tabs, setTabs] = useState<PageTab[]>(load);
  const [grid, setGrid] = useState(false);
  const last = useRef(hash);
  const activity = useActivity();
  const titleOf = useTitles();

  // Every place she goes becomes (or switches to) a tab.
  useEffect(() => {
    if (off) return;
    setTabs((now) => {
      const next = openTab(now, last.current, hash);
      save(next);
      return next;
    });
    last.current = hash;
    setGrid(false);
  }, [hash, off]);

  const update = (next: PageTab[]) => {
    setTabs(next);
    save(next);
  };
  const close = (h: string) => {
    const r = closeTab(tabs, h, hash);
    update(r.tabs);
    if (r.go) location.hash = r.go;
  };

  useEffect(() => {
    if (off) return;
    const key = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === "Tab") {
        e.preventDefault();
        location.hash = stepTab(tabs, hash, e.shiftKey ? -1 : 1);
      }
    };
    addEventListener("keydown", key);
    return () => removeEventListener("keydown", key);
  }, [tabs, hash, off]);

  if (off) return null;
  const showing = placeOf(hash);
  const tab = (tb: PageTab) => {
    const { icon, title, chatId } = titleOf(tb.hash);
    const on = placeOf(tb.hash) === showing;
    const busy = chatId && activity[chatId] === "running";
    return (
      <div
        key={placeOf(tb.hash)}
        role="tab"
        aria-selected={on}
        className={`page-tab${on ? " on" : ""}${tb.preview ? " preview" : ""}`}
        title={tb.preview ? L(`${title} (תצוגה זמנית: לחיצה כפולה משאירה אותו)`, `${title} (preview: double-click keeps it)`) : title}
        onMouseDown={(e) => {
          if (e.button === 1) {
            e.preventDefault();
            close(tb.hash);
          }
        }}
        onDoubleClick={() => update(pinTab(tabs, tb.hash))}
      >
        <a href={tb.hash} className="page-tab-link" dir="auto">
          <span aria-hidden="true">{icon}</span>
          <span className="page-tab-title">{title}</span>
          {busy && <span className="page-tab-dot" aria-label={L("עונה עכשיו", "Answering now")} />}
        </a>
        <button type="button" className="page-tab-x" aria-label={L(`סגירת ${title}`, `Close ${title}`)} onClick={() => close(tb.hash)}>✕</button>
      </div>
    );
  };
  return (
    <>
      <nav className="page-tabs" role="tablist" aria-label={L("טאבים פתוחים", "Open tabs")}>
        <a href={HOME} role="tab" aria-selected={showing === placeOf(HOME)} className={`page-tab home${showing === placeOf(HOME) ? " on" : ""}`} title={L("בית", "Home")}>⌂</a>
        <div className="page-tabs-row">{tabs.map(tab)}</div>
        <button type="button" className="page-tabs-count" aria-label={L(`${tabs.length + 1} טאבים פתוחים`, `${tabs.length + 1} open tabs`)} aria-expanded={grid} onClick={() => setGrid(!grid)}>
          {tabs.length + 1}
        </button>
      </nav>
      {grid && (
        <div className="dialog-backdrop" role="presentation" onClick={() => setGrid(false)}>
          <div className="dialog card page-tabs-grid" role="dialog" aria-modal="true" aria-label={L("הטאבים הפתוחים", "Open tabs")} onClick={(e) => e.stopPropagation()}>
            <strong>{L("הטאבים הפתוחים", "Open tabs")}</strong>
            <div className="page-tabs-cards">
              <a href={HOME} className={`card page-tab-card${showing === placeOf(HOME) ? " on" : ""}`}>⌂ {L("בית", "Home")}</a>
              {tabs.map((tb) => {
                const { icon, title } = titleOf(tb.hash);
                return (
                  <div key={placeOf(tb.hash)} className={`card page-tab-card${placeOf(tb.hash) === showing ? " on" : ""}`}>
                    <a href={tb.hash} dir="auto">{icon} {title}</a>
                    <button type="button" className="icon-btn" aria-label={L(`סגירת ${title}`, `Close ${title}`)} onClick={() => close(tb.hash)}>✕</button>
                  </div>
                );
              })}
            </div>
            {tabs.length > 0 && <button type="button" className="ghost" onClick={() => { update([]); location.hash = HOME; }}>{L("סגירת כל הטאבים", "Close all tabs")}</button>}
          </div>
        </div>
      )}
    </>
  );
}

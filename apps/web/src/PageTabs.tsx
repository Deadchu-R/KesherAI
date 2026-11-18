import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { createConversation } from "./library";
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
 * Tabs for the open pages (design TabsImageEditor): quiet pills for chats, editors, documents and pages. Going
 * somewhere new opens a preview tab (in italics) that the next place replaces; a double click keeps it. A dot shows
 * while a chat answers. Ctrl+Tab and Ctrl+Shift+Tab go round them, a middle click closes one. On a phone (narrow
 * screens) the row becomes a counter in the corner that opens the open tabs as cards. Shown only from two open
 * places; off in Settings → Appearance.
 *
 * @param props.hash - The address showing now.
 */
export function PageTabs({ hash }: { hash: string }) {
  const off = useAppearance().pageTabs === false;
  const [tabs, setTabs] = useState<PageTab[]>(load);
  const [grid, setGrid] = useState(false);
  const [quick, setQuick] = useState(false);
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const press = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pressed = useRef(false);
  useEffect(() => {
    setSlot(document.getElementById("appbar-tabs"));
  }, []);
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
      // Ctrl+1…8 opens that tab and Ctrl+9 the last one, as in Chrome (1 is Home).
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && /^[1-9]$/.test(e.key)) {
        const all = [HOME, ...tabs.map((x) => x.hash)];
        const n = Number(e.key);
        e.preventDefault();
        location.hash = n === 9 ? all[all.length - 1]! : all[Math.min(n, all.length) - 1]!;
      }
    };
    addEventListener("keydown", key);
    return () => removeEventListener("keydown", key);
  }, [tabs, hash, off]);

  // With one place open the row says nothing the sidebar does not, so it is not there at all (Safari, VS Code's
  // "single" mode; asked 2026-11-18). It appears from two places on.
  // On a phone, a swipe along the top bar goes to the next or previous tab, as in Safari and Chrome; while the
  // finger moves, the neighbour's name peeks in from that side.
  const [peek, setPeek] = useState<{ side: "start" | "end"; title: string } | null>(null);
  useEffect(() => {
    const bar = document.querySelector<HTMLElement>(".appbar");
    if (off || !bar || tabs.length < 2) return;
    let x0 = 0, y0 = 0, on = false;
    const dirOf = (dx: number) => ((dx < 0) === (document.dir === "rtl" || getLocale() === "he") ? 1 : -1);
    const start = (e: TouchEvent) => { if (!matchMedia("(max-width: 760px)").matches) return; on = true; x0 = e.touches[0]!.clientX; y0 = e.touches[0]!.clientY; };
    const move = (e: TouchEvent) => {
      if (!on) return;
      const dx = e.touches[0]!.clientX - x0;
      if (Math.abs(dx) < 24 || Math.abs(e.touches[0]!.clientY - y0) > 40) return setPeek(null);
      const next = stepTab(tabs, hash, dirOf(dx));
      setPeek({ side: dx < 0 ? "end" : "start", title: titleOf(next).title });
    };
    const end = (e: TouchEvent) => {
      if (!on) return;
      on = false;
      setPeek(null);
      const dx = e.changedTouches[0]!.clientX - x0;
      if (Math.abs(dx) > 70 && Math.abs(e.changedTouches[0]!.clientY - y0) < 40) location.hash = stepTab(tabs, hash, dirOf(dx));
    };
    bar.addEventListener("touchstart", start, { passive: true });
    bar.addEventListener("touchmove", move, { passive: true });
    bar.addEventListener("touchend", end);
    return () => { bar.removeEventListener("touchstart", start); bar.removeEventListener("touchmove", move); bar.removeEventListener("touchend", end); };
  }, [tabs, hash, off]);

  if (off || (tabs.length < 2 && !grid)) return null;
  const showing = placeOf(hash);
  const tab = (tb: PageTab) => {
    const { icon, title, chatId } = titleOf(tb.hash);
    const on = placeOf(tb.hash) === showing;
    const busy = chatId && activity[chatId] === "running";
    return (
      <div
        key={placeOf(tb.hash)}
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
        <a href={tb.hash} aria-current={on ? "page" : undefined} className="page-tab-link" dir="auto">
          <span aria-hidden="true">{icon}</span>
          <span className="page-tab-title">{title}</span>
          {busy && <span className="page-tab-dot" aria-label={L("עונה עכשיו", "Answering now")} />}
        </a>
        <button type="button" className="page-tab-x" aria-label={L(`סגירת ${title}`, `Close ${title}`)} onClick={() => close(tb.hash)}>✕</button>
      </div>
    );
  };
  const count = (
    <span className="page-tabs-count-wrap">
      <button
        type="button"
        className="page-tabs-count"
        aria-label={L(`${tabs.length + 1} טאבים פתוחים`, `${tabs.length + 1} open tabs`)}
        aria-expanded={grid}
        // A long press opens the quick menu (new chat, close this tab), as Chrome's tab button.
        onPointerDown={() => { pressed.current = false; press.current = setTimeout(() => { pressed.current = true; setQuick(true); }, 450); }}
        onPointerUp={() => clearTimeout(press.current)}
        onPointerLeave={() => clearTimeout(press.current)}
        onContextMenu={(e) => e.preventDefault()}
        onClick={() => { if (!pressed.current) setGrid(!grid); }}
      >
        {tabs.length + 1}
      </button>
      {quick && (
        <span className="page-tabs-quick card" role="menu" onPointerLeave={() => setQuick(false)}>
          <button type="button" role="menuitem" onClick={() => { setQuick(false); void createConversation({ kind: "chat" }).then((id) => { if (id) location.hash = `#/c/${id}`; }); }}>＋ {L("צ'אט חדש", "New chat")}</button>
          {showing !== placeOf(HOME) && <button type="button" role="menuitem" onClick={() => { setQuick(false); close(hash); }}>✕ {L("סגירת הטאב הזה", "Close this tab")}</button>}
          {tabs.length > 1 && <button type="button" role="menuitem" onClick={() => { setQuick(false); update(tabs.filter((t) => placeOf(t.hash) === showing)); }}>⊟ {L("סגירת שאר הטאבים", "Close the other tabs")}</button>}
        </span>
      )}
    </span>
  );
  return (
    <>
      {slot && createPortal(count, slot)}
      {peek && <div className={`page-tabs-peek ${peek.side}`} aria-hidden>{peek.side === "end" ? `${peek.title} ←` : `→ ${peek.title}`}</div>}
      <nav className="page-tabs" aria-label={L("טאבים פתוחים", "Open tabs")}>
        <div className="page-tabs-list">
        <div className="page-tabs-row">{tabs.map(tab)}</div>
        </div>
      </nav>
      {grid && (
        // All the tabs as cards (Chrome's and Safari's tab switcher): full screen on a phone, two in a row; a card swiped
        // aside closes, as in Chrome.
        <div className="dialog-backdrop" role="presentation" onClick={() => setGrid(false)}>
          <div className="dialog card page-tabs-grid" role="dialog" aria-modal="true" aria-label={L("הטאבים הפתוחים", "Open tabs")} onClick={(e) => e.stopPropagation()}>
            <header className="row">
              <strong className="grow">{L(`${tabs.length + 1} טאבים`, `${tabs.length + 1} tabs`)}</strong>
              <button type="button" onClick={() => void createConversation({ kind: "chat" }).then((id) => { if (id) location.hash = `#/c/${id}`; })}>＋ {L("צ'אט חדש", "New chat")}</button>
            </header>
            <div className="page-tabs-cards">
              <a href={HOME} className={`card page-tab-card${showing === placeOf(HOME) ? " on" : ""}`}><span className="page-tab-card-head">⌂ {L("בית", "Home")}</span></a>
              {tabs.map((tb) => {
                const { icon, title } = titleOf(tb.hash);
                return (
                  <SwipeCard key={placeOf(tb.hash)} onClose={() => close(tb.hash)} className={`card page-tab-card${placeOf(tb.hash) === showing ? " on" : ""}${tb.preview ? " preview" : ""}`}>
                    <span className="page-tab-card-head">
                      <a href={tb.hash} dir="auto">{icon} <span className="page-tab-title">{title}</span></a>
                      <button type="button" className="icon-btn" aria-label={L(`סגירת ${title}`, `Close ${title}`)} onClick={() => close(tb.hash)}>✕</button>
                    </span>
                    <a href={tb.hash} className="page-tab-card-body" tabIndex={-1} aria-hidden dir="auto"><span className="page-tab-card-icon">{icon}</span>{kindOf(tb.hash)}</a>
                  </SwipeCard>
                );
              })}
            </div>
            <footer className="row">
              {tabs.length > 0 && <button type="button" className="ghost" onClick={() => { update([]); location.hash = HOME; }}>{L("סגירת הכל", "Close all")}</button>}
              <span className="grow" />
              <button type="button" className="primary" onClick={() => setGrid(false)}>{L("סיום", "Done")}</button>
            </footer>
          </div>
        </div>
      )}
    </>
  );
}

/** What a tab is, in a word, for its card in the switcher. */
function kindOf(hash: string): string {
  const place = placeOf(hash);
  if (place.startsWith("#/c/")) return L("צ'אט", "Chat");
  if (place.startsWith("#/p/")) return /editor/.test(place) ? L("עורך", "Editor") : L("כלי", "Tool");
  if (place.startsWith("#/settings")) return L("הגדרות", "Settings");
  return L("עמוד", "Page");
}

/** A tab card that closes when it is swiped aside more than a third of its width (Chrome's tab switcher). */
function SwipeCard({ onClose, className, children }: { onClose: () => void; className: string; children: ReactNode }) {
  const [dx, setDx] = useState(0);
  const x0 = useRef<number | null>(null);
  return (
    <div
      className={className}
      style={dx ? { transform: `translateX(${dx}px)`, opacity: Math.max(0.2, 1 - Math.abs(dx) / 220) } : undefined}
      onTouchStart={(e) => { x0.current = e.touches[0]!.clientX; }}
      onTouchMove={(e) => { if (x0.current !== null) setDx(e.touches[0]!.clientX - x0.current); }}
      onTouchEnd={(e) => {
        const w = (e.currentTarget as HTMLElement).offsetWidth;
        x0.current = null;
        if (Math.abs(dx) > w / 3) onClose();
        setDx(0);
      }}
    >
      {children}
    </div>
  );
}

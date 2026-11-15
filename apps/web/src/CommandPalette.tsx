import { useEffect, useMemo, useRef, useState } from "react";
import { createConversation, toast, useLibrary } from "./library";
import { api } from "./api";
import { getLocale, t } from "./i18n";
import { NAV_GROUPS, NAV_ICONS, useNavItems } from "./Sidebar";
import { useParts } from "./parts";
import { fit } from "./palette-fit";
import { handheldSetting, setHandheld } from "./PadHints";
import { Glyph } from "./ui/Glyph";
import { isShortcut } from "./keyboard";

const L = (he: string, en: string) => (getLocale() === "he" ? he : en);

/** One line of the palette. */
interface Entry {
  id: string;
  icon: string;
  title: string;
  /** Words it is found by besides its title (the other language, the page's address). */
  also?: string;
  group: "action" | "page" | "chat";
  run: () => void;
}

/** Opens the palette from anywhere (a button, another component). */
export function openPalette(): void {
  window.dispatchEvent(new Event("kesher:palette"));
}

/**
 * The command palette (Ctrl+K, as in Claude, Linear, Raycast, Slack): one box for going anywhere (every page of the
 * menu, the chats by title) and doing the common things (a new chat or code session, checking for updates). Arrow
 * keys and Enter, Esc closes; on a phone the 🔍 in the top bar opens it.
 */
export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [at, setAt] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const back = useRef<Element | null>(null);
  const { conversations } = useLibrary();
  const nav = useNavItems();
  const { simple } = useParts();

  useEffect(() => {
    const show = () => {
      back.current = document.activeElement;
      setQ("");
      setAt(0);
      setOpen(true);
    };
    const key = (e: KeyboardEvent) => {
      if (isShortcut(e, "palette")) {
        // The code editor keeps its own Ctrl+K chords.
        if ((e.target as Element | null)?.closest?.(".monaco-editor")) return;
        e.preventDefault();
        setOpen((o) => {
          if (!o) {
            back.current = document.activeElement;
            setQ("");
            setAt(0);
          }
          return !o;
        });
      }
    };
    window.addEventListener("kesher:palette", show);
    window.addEventListener("keydown", key, true);
    return () => {
      window.removeEventListener("kesher:palette", show);
      window.removeEventListener("keydown", key, true);
    };
  }, []);
  useEffect(() => {
    if (open) setTimeout(() => input.current?.focus(), 0);
  }, [open]);

  const close = () => {
    setOpen(false);
    (back.current as HTMLElement | null)?.focus?.();
  };
  const go = (hash: string) => () => {
    location.hash = hash;
  };

  const entries = useMemo((): Entry[] => {
    const actions: Entry[] = [
      { id: "new-chat", icon: "💬", title: L("צ'אט חדש", "New chat"), also: "new chat צאט חדש", group: "action", run: () => void createConversation({ kind: "chat" }).catch((e: Error) => toast(e.message)) },
      ...(simple ? [] : [{ id: "new-code", icon: "</>", title: L("סשן קוד חדש", "New code session"), also: "new code קוד חדש", group: "action" as const, run: go("#/code") }]),
      { id: "updates", icon: "⟳", title: L("בדיקת עדכונים", "Check for updates"), also: "updates עדכונים", group: "action", run: go("#/updates") },
      { id: "settings", icon: "⚙", title: L("הגדרות", "Settings"), also: "settings הגדרות", group: "action", run: go("#/settings") },
      (() => {
        // The handheld look (bigger targets): automatic on a handheld gaming PC, or on / off by hand.
        const now = document.documentElement.classList.contains("handheld");
        return {
          id: "handheld",
          icon: "🎮",
          title: now ? L("כיבוי מצב מחשב כף יד", "Turn off the handheld look") : L("הפעלת מצב מחשב כף יד (כפתורים גדולים)", "Turn on the handheld look (bigger buttons)"),
          also: "handheld ally steam deck controller gamepad שלט כף יד",
          group: "action" as const,
          run: () => {
            const was = handheldSetting();
            const detected = !!document.documentElement.dataset.handheld;
            setHandheld(now ? (detected ? "off" : "auto") : detected && was === "off" ? "auto" : "on");
          },
        };
      })(),
      {
        id: "screens-off",
        icon: "🌙",
        title: L("כיבוי המסכים (המחשב ממשיך לעבוד)", "Turn off the screens (the computer keeps working)"),
        also: "screens off monitor sleep display מסכים כיבוי",
        group: "action" as const,
        run: () => void api("/api/system/screens-off", { method: "POST" }).catch((e: Error) => toast(e.message)),
      },
      {
        // What the app sees of controllers (a ROG Ally in Desktop mode sends keys, not a controller).
        id: "pad-check",
        icon: "🎮",
        title: L("בדיקת שלט", "Controller check"),
        also: "controller gamepad xinput ally שלט בדיקה",
        group: "action" as const,
        run: () => {
          const pads = typeof navigator.getGamepads === "function" ? [...navigator.getGamepads()].filter((p): p is Gamepad => !!p) : [];
          toast(
            pads.length
              ? L(`נמצא שלט: ${pads.map((p) => p.id).join(", ")}`, `Controller found: ${pads.map((p) => p.id).join(", ")}`)
              : L("לא נמצא שלט. לחצו על כפתור בשלט ונסו שוב. ב-ROG Ally: Command Center ← Control mode ← Gamepad (במצב Desktop השלט שולח מקשים: החיצים, Enter ו-Esc עובדים).", "No controller found. Press a button on it and try again. On a ROG Ally: Command Center → Control mode → Gamepad (in Desktop mode it sends keys: the arrows, Enter and Esc work)."),
          );
        },
      },
    ];
    // The menu's own pages (without parts that are off, or what simple mode leaves out), plus All tools.
    const groupOf = (id: string) => NAV_GROUPS.find((g) => g.id === id);
    const pages: Entry[] = [
      ...nav.map((n) => ({ id: `page:${n.href}`, icon: NAV_ICONS[n.href] ?? "•", title: n.label, also: `${n.href.slice(2)} ${groupOf(n.group) ? t(groupOf(n.group)!.label) : ""}`, group: "page" as const, run: go(n.href) })),
      { id: "page:#/apps", icon: "▦", title: t("allTools"), also: "apps tools כלים", group: "page" as const, run: go("#/apps") },
    ];
    const chats: Entry[] = [...conversations]
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
      .map((c) => ({ id: `chat:${c.id}`, icon: c.kind === "code" ? "</>" : "💬", title: c.title || L("צ'אט בלי שם", "Untitled chat"), group: "chat" as const, run: go(`#/c/${c.id}`) }));
    return [...actions, ...pages, ...chats];
  }, [conversations, open, nav, simple]);

  const shown = useMemo(() => {
    const query = q.trim();
    if (!query) {
      // Empty: the actions, the five latest chats, then the pages.
      const g = (k: Entry["group"]) => entries.filter((e) => e.group === k);
      return [...g("action"), ...g("chat").slice(0, 5), ...g("page")];
    }
    return entries
      .map((e) => ({ e, s: Math.max(fit(query, e.title), fit(query, e.also ?? "") * 0.9) + (e.group === "action" ? 3 : e.group === "page" ? 2 : 0) }))
      .filter((x) => x.s > 3)
      .sort((a, b) => b.s - a.s)
      .slice(0, 30)
      .map((x) => x.e);
  }, [entries, q]);

  useEffect(() => {
    list.current?.querySelector(`[data-i="${at}"]`)?.scrollIntoView({ block: "nearest" });
  }, [at]);

  if (!open) return null;
  const pick = (e: Entry | undefined) => {
    if (!e) return;
    setOpen(false);
    e.run();
  };
  const groupName: Record<Entry["group"], string> = { action: L("פעולות", "Actions"), page: L("עמודים", "Pages"), chat: L("צ'אטים", "Chats") };
  return (
    <div className="palette-back" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div className="palette card" role="dialog" aria-modal="true" aria-label={L("חיפוש ופקודות", "Search and commands")}>
        <input
          ref={input}
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setAt(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setAt((i) => Math.min(shown.length - 1, i + 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setAt((i) => Math.max(0, i - 1));
            } else if (e.key === "Enter") {
              e.preventDefault();
              pick(shown[at]);
            } else if (e.key === "Escape") {
              e.preventDefault();
              close();
            }
          }}
          placeholder={L("לאן ללכת או מה לעשות… (עמוד, צ'אט, פעולה)", "Go to or do… (a page, a chat, an action)")}
          aria-label={L("חיפוש ופקודות", "Search and commands")}
          role="combobox"
          aria-expanded="true"
          aria-controls="palette-list"
          aria-activedescendant={shown[at] ? `palette-${at}` : undefined}
        />
        <ul id="palette-list" ref={list} role="listbox" className="palette-list">
          {shown.length === 0 && <li className="muted small palette-none">{L("לא נמצא. נסו מילה אחרת.", "Nothing found. Try another word.")}</li>}
          {shown.map((e, i) => (
            <li key={e.id} role="presentation">
              {(i === 0 || shown[i - 1]!.group !== e.group) && <div className="palette-group muted small">{groupName[e.group]}</div>}
              <button
                type="button"
                id={`palette-${i}`}
                data-i={i}
                role="option"
                aria-selected={i === at}
                className={i === at ? "on" : ""}
                onPointerMove={() => i !== at && setAt(i)}
                onClick={() => pick(e)}
              >
                <span className="palette-icon" aria-hidden="true"><Glyph of={e.icon} /></span>
                <span className="grow palette-title">{e.title}</span>
              </button>
            </li>
          ))}
        </ul>
        <div className="palette-foot muted small" aria-hidden="true">
          <span><kbd>↑↓</kbd> {L("בחירה", "choose")}</span>
          <span><kbd>Enter</kbd> {L("פתיחה", "open")}</span>
          <span><kbd>Esc</kbd> {L("סגירה", "close")}</span>
        </div>
      </div>
    </div>
  );
}

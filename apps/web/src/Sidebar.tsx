import { useEffect, useRef, useState } from "react";
import { branding, type ConversationSummary } from "@kesher/shared";
import { ToolIcon } from "./ToolIcon";
import { SidebarShortcuts } from "./SidebarShortcuts";
import { SidebarEdit } from "./SidebarEdit";
import { useAppMenu } from "./AppMenu";
import { api, appHome, disconnectComputer, isRemote } from "./api";
import { createConversation, desktop, refreshLibrary, toast, useActivity, useLibrary } from "./library";
import { getLocale, setLocale, t } from "./i18n";
import { NEW_CODE_EVENT } from "./AppBar";
import { usePluginUi } from "./plugins";
import { pageHidden } from "@kesher/shared";
import { useParts } from "./parts";
import { QuickMenu } from "./QuickMenu";
import { AccountButton } from "./AccountButton";
import { Select } from "./ui/Select";
import { Menu, MenuItem, MenuSeparator } from "./ui/Menu";

/** A dialog for a new code session or a new project. */
function NewDialog({ kind, onClose }: { kind: "code" | "project"; onClose: () => void }) {
  const { projects } = useLibrary();
  const [folder, setFolder] = useState("");
  const [name, setName] = useState("");
  const [instructions, setInstructions] = useState("");
  const [projectId, setProjectId] = useState("");
  const [error, setError] = useState("");
  const project = projects.find((p) => p.id === projectId);

  async function submit() {
    setError("");
    try {
      if (kind === "project") {
        const p = await api<{ id: string }>("/api/projects", {
          method: "POST",
          body: { name, ...(folder ? { workspace: folder } : {}), ...(instructions ? { instructions } : {}) },
        });
        await refreshLibrary();
        if (folder) await createConversation({ kind: "code", projectId: p.id });
      } else {
        await createConversation({ kind: "code", ...(projectId ? { projectId } : {}), ...(folder ? { workspace: folder } : {}) });
      }
      onClose();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div className="dialog-backdrop" role="presentation" onClick={onClose}>
      <form
        className="dialog card"
        role="dialog"
        aria-modal="true"
        aria-label={kind === "project" ? t("newProject") : t("newCode")}
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <h2>{kind === "project" ? t("newProject") : t("newCode")}</h2>
        {kind === "project" && (
          <label>
            {t("name")}
            <input required autoFocus value={name} onChange={(e) => setName(e.target.value)} />
          </label>
        )}
        {kind === "code" && projects.length > 0 && (
          <label>
            {t("project")}
            <Select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              <option value="">{t("noProject")}</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </label>
        )}
        {!(kind === "code" && project?.workspace) && (
          <label>
            {t("folder")}
            <div className="row">
              <input className="grow" dir="ltr" required={kind === "code"} placeholder={t("folderHint")} value={folder} onChange={(e) => setFolder(e.target.value)} />
              {desktop() && (
                <button type="button" onClick={() => void desktop()!.pickFolder().then((f) => f && setFolder(f))}>
                  {t("browse")}
                </button>
              )}
            </div>
          </label>
        )}
        {kind === "project" && (
          <label>
            {t("instructions")}
            <textarea rows={3} value={instructions} onChange={(e) => setInstructions(e.target.value)} />
          </label>
        )}
        {error && <p className="error">{error}</p>}
        <div className="row" style={{ justifyContent: "flex-end" }}>
          <button type="button" onClick={onClose}>
            {t("cancel")}
          </button>
          <button type="submit" className="primary">
            {t("create")}
          </button>
        </div>
      </form>
    </div>
  );
}

function ConversationLink({ c, active }: { c: ConversationSummary; active: boolean }) {
  const state = useActivity()[c.id];
  const he = getLocale() === "he";
  // Delete a chat from the list (asked for on Linux: there was no way to remove old chats).
  const remove = async () => {
    if (!confirm(he ? `למחוק את הצ'אט "${c.title}"? אי אפשר לבטל את זה.` : `Delete the chat "${c.title}"? This cannot be undone.`)) return;
    // A session in its own worktree: a clean one goes with it; one with work in it is the user's call.
    let worktree = "";
    if (c.worktree) {
      const w = await api<{ branch: string; changed: number; commits: number } | null>(`/api/conversations/${c.id}/worktree`).catch(() => null);
      if (w && (w.changed || w.commits)) {
        const lose = he ? `${w.changed} קבצים ששונו ו-${w.commits} קומיטים בענף ${w.branch}` : `${w.changed} changed files and ${w.commits} commits on ${w.branch}`;
        worktree = confirm(he ? `ב-worktree של הסשן יש עבודה: ${lose}.\n\nאישור = למחוק גם אותה. ביטול = להשאיר את ה-worktree והענף בדיסק.` : `The session's worktree holds work: ${lose}.\n\nOK = delete it too. Cancel = keep the worktree and branch on disk.`) ? "?worktree=remove" : "?worktree=keep";
      }
    }
    try {
      await api(`/api/conversations/${c.id}${worktree}`, { method: "DELETE" });
      if (active) location.hash = "#/";
      await refreshLibrary();
    } catch (e) {
      toast((e as Error).message);
    }
  };
  const rename = async () => {
    const title = prompt(he ? "שם חדש לצ'אט" : "A new name for the chat", c.title)?.trim();
    if (!title || title === c.title) return;
    await api(`/api/conversations/${c.id}`, { method: "PATCH", body: { title } }).then(() => refreshLibrary(), (e: Error) => toast(e.message));
  };
  return (
    <div className="conv-row">
      <a href={`#/c/${c.id}`} className="nav-link conv-link" aria-current={active ? "page" : undefined} title={c.title}>
        <span className="conv-kind" aria-hidden="true">
          {c.kind === "code" ? "</>" : "•"}
        </span>
        <span className="conv-title">{c.title}</span>
        {state && <span className={`conv-live ${state}`} title={state === "running" ? t("convRunning") : t("convWaiting")} aria-label={state === "running" ? t("convRunning") : t("convWaiting")} />}
      </a>
      <Menu trigger="⋯" triggerClassName="icon-btn conv-more" aria-label={he ? `אפשרויות: ${c.title}` : `Options: ${c.title}`}>
        <MenuItem icon="✏" onSelect={() => void rename()}>{he ? "שינוי שם" : "Rename"}</MenuItem>
        <MenuSeparator />
        <MenuItem icon="🗑" danger onSelect={() => void remove()}>{he ? "מחיקת הצ'אט" : "Delete the chat"}</MenuItem>
      </Menu>
    </div>
  );
}

/** The left sidebar: new buttons, projects with their conversations, other screens. */
/** The menu's pages in groups (the sidebar, and the top bar's menu on a phone). Plugin pages join "create". */
export const NAV_GROUPS: Array<{ id: string; icon: string; label: Parameters<typeof t>[0]; items: Array<[string, Parameters<typeof t>[0]]> }> = [
  { id: "create", icon: "🎨", label: "navCreate", items: [["#/images", "images"], ["#/batch", "batchNav"], ["#/nodes", "nodesNav"], ["#/unreal", "unrealNav"], ["#/unity", "unityNav"], ["#/training", "trainingNav"]] },
  { id: "work", icon: "🧠", label: "navWork", items: [["#/pages", "pagesNav"], ["#/knowledge", "knowledgeNav"], ["#/libraries", "librariesNav"], ["#/day", "dayNav"], ["#/compare", "compareNav"], ["#/pipelines", "pipelinesNav"], ["#/inbox", "inboxNav"], ["#/watch", "watchNav"], ["#/self-work", "selfWorkNav"]] },
  { id: "assistant", icon: "🤖", label: "navAssistant", items: [["#/personas", "personasNav"], ["#/memory", "memoryNav"], ["#/prompts", "promptsNav"], ["#/community", "communityNav"], ["#/usage", "usageNav"]] },
  { id: "system", icon: "⚙", label: "navSystem", items: [["#/models", "models"], ["#/connections", "connections"], ["#/plugins", "pluginsNav"], ["#/parts", "partsNav"], ["#/health", "healthNav"], ["#/updates", "updatesNav"], ["#/settings", "settings"]] },
];

/** An icon for each menu page (the sidebar's pins, the Tools page, the phone's bar). */
export const NAV_ICONS: Record<string, string> = {
  "#/images": "🖼", "#/batch": "🗂", "#/nodes": "🧩", "#/unreal": "🎮", "#/unity": "🕹", "#/training": "🏋",
  "#/pages": "📝", "#/knowledge": "📚", "#/libraries": "📦", "#/day": "📅", "#/compare": "⚖", "#/pipelines": "⛓", "#/watch": "🖥", "#/inbox": "🔔", "#/self-work": "🤖",
  "#/personas": "🎭", "#/memory": "🧠", "#/prompts": "💬", "#/community": "👥", "#/usage": "📊",
  "#/models": "📦", "#/connections": "🔌", "#/plugins": "🧷", "#/parts": "🎛", "#/health": "🩺", "#/updates": "⬆", "#/settings": "⚙",
};

const PIN_KEY = "kesher.pins";
export const DEFAULT_PINS = ["#/images", "#/pages", "#/knowledge", "#/models"];
let pins: string[] | null = null;
const pinListeners = new Set<() => void>();

/**
 * The pages pinned to the top of the sidebar: one list on the computer (/api/pins), so the phone and the computer
 * show the same menu (Roee: "one unified menu"). A copy in this browser shows it at once; the computer's list
 * replaces it when it arrives. A device whose pins were changed before this (kept only here) gives them to the
 * computer once, when the computer has none yet.
 *
 * @returns The pinned pages and a toggle.
 */
export function usePins(): [string[], (href: string) => void] {
  const [, tick] = useState(0);
  useEffect(() => {
    const on = () => tick((n) => n + 1);
    pinListeners.add(on);
    return () => void pinListeners.delete(on);
  }, []);
  if (!pins) {
    let local: string[] | null = null;
    try {
      local = JSON.parse(localStorage.getItem(PIN_KEY) ?? "null") as string[] | null;
    } catch {
      local = null;
    }
    pins = local ?? DEFAULT_PINS;
    if (!pinsAsked) {
      pinsAsked = true;
      void api<{ pins: string[] | null }>("/api/pins").then(
        (r) => {
          if (r.pins) applyPins(r.pins, false);
          else if (local) void savePins(local);
        },
        () => undefined,
      );
    }
  }
  const toggle = (href: string) => {
    const next = pins!.includes(href) ? pins!.filter((x) => x !== href) : [...pins!, href];
    applyPins(next, true);
  };
  return [pins, toggle];
}

let pinsAsked = false;
const savePins = (next: string[]) => api("/api/pins", { method: "PUT", body: { pins: next } }).catch(() => undefined);
/** Shows a list of pins (and keeps it on the computer when it is the user's change). */
function applyPins(next: string[], save: boolean): void {
  pins = next;
  try {
    localStorage.setItem(PIN_KEY, JSON.stringify(pins));
  } catch {
    // only for this visit
  }
  pinListeners.forEach((l) => l());
  if (save) void savePins(next);
}

/** Puts the pinned pages in a new order (long press and drag in the sidebar, or the ✏ edit mode). */
export function setPinOrder(next: string[]): void {
  applyPins(next, true);
}

/** Shows pins that were changed on the computer (the design assistant's change_menu). */
export function showPins(next: string[] | null): void {
  applyPins(next ?? DEFAULT_PINS, false);
}

/**
 * Long press, then drag, to reorder a list of links (mouse or finger).
 * A short press still opens the link; moving before the press is long
 * enough scrolls as usual.
 *
 * @param order - The items, in order.
 * @param onOrder - Saves the new order.
 */
function useDragOrder(order: string[], onOrder: (next: string[]) => void) {
  const [dragging, setDragging] = useState<string | null>(null);
  const press = useRef<{ id: string; x: number; y: number; timer: number } | null>(null);
  const moved = useRef(false);
  // While dragging with a finger, the page must not scroll (that would cancel the drag).
  useEffect(() => {
    if (!dragging) return;
    const stop = (e: TouchEvent) => e.preventDefault();
    document.addEventListener("touchmove", stop, { passive: false });
    return () => document.removeEventListener("touchmove", stop);
  }, [dragging]);
  const cancel = () => {
    if (press.current) window.clearTimeout(press.current.timer);
    press.current = null;
  };
  const props = (id: string) => ({
    "data-drag-id": id,
    // A link's own drag (to the address bar) would take over the mouse.
    draggable: false,
    onDragStart: (e: React.DragEvent) => e.preventDefault(),
    onPointerDown: (e: React.PointerEvent<HTMLElement>) => {
      if (e.button !== 0) return;
      moved.current = false;
      const el = e.currentTarget;
      const pointer = e.pointerId;
      press.current = {
        id,
        x: e.clientX,
        y: e.clientY,
        timer: window.setTimeout(() => {
          setDragging(id);
          moved.current = true;
          try {
            el.setPointerCapture(pointer);
          } catch {
            // the pointer is gone
          }
          navigator.vibrate?.(12);
        }, 450),
      };
    },
    onPointerMove: (e: React.PointerEvent<HTMLElement>) => {
      if (!dragging) {
        if (press.current && Math.hypot(e.clientX - press.current.x, e.clientY - press.current.y) > 8) cancel();
        return;
      }
      e.preventDefault();
      const over = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>("[data-drag-id]")?.dataset.dragId;
      if (!over || over === dragging || !order.includes(over)) return;
      const next = order.filter((x) => x !== dragging);
      const at = next.indexOf(over) + (order.indexOf(over) > order.indexOf(dragging) ? 1 : 0);
      next.splice(at, 0, dragging);
      onOrder(next);
    },
    onPointerUp: () => {
      cancel();
      setDragging(null);
    },
    onPointerCancel: () => {
      cancel();
      setDragging(null);
    },
    onClick: (e: React.MouseEvent) => {
      // The press that ended a drag does not open the page.
      if (moved.current) {
        e.preventDefault();
        moved.current = false;
      }
    },
    onContextMenu: (e: React.MouseEvent) => {
      if (press.current || dragging) e.preventDefault();
    },
  });
  return { dragging, props };
}

/** Every menu page, in menu order. */
export const NAV: Array<[string, Parameters<typeof t>[0]]> = NAV_GROUPS.flatMap((g) => g.items);

/**
 * @returns The menu's pages, without the parts that are off, with the
 *   pages plugins add (the image editor, …) in "create", as
 *   `[href, label, group]`.
 */
export function useNavItems(): Array<{ href: string; label: string; group: string }> {
  const { parts } = useParts();
  const { pages } = usePluginUi();
  const off = Object.fromEntries(parts.filter((p) => !p.on).map((p) => [p.id, false]));
  return NAV_GROUPS.flatMap((g) => [
    ...g.items.filter(([h]) => !pageHidden(off, h)).map(([href, key]) => ({ href, label: t(key), group: g.id })),
    ...(g.id === "create" ? pages.map((p) => ({ href: `#/p/${p.pluginId}/${p.id}`, label: `${p.icon ? `${p.icon} ` : ""}${p.title}`, group: g.id })) : []),
  ]);
}


export function Sidebar({ hash, online, open: menuOpen, onLocale }: { hash: string; online: boolean | null; open: boolean; onLocale: () => void }) {
  const { projects, conversations } = useLibrary();
  const [dialog, setDialog] = useState<"code" | "project" | null>(null);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const searching = useSearching();
  // ✏: the menu becomes a list to reorder, hide and add to (like Linear's "Customize sidebar").
  const [editing, setEditing] = useState(false);
  const [version, setVersion] = useState("");
  const activeId = hash.startsWith("#/c/") ? hash.slice(4) : "";

  useEffect(() => {
    const open = () => setDialog("code");
    addEventListener(NEW_CODE_EVENT, open);
    return () => removeEventListener(NEW_CODE_EVENT, open);
  }, []);

  useEffect(() => {
    api<{ version: string; commit?: string }>("/api/version")
      .then((v) => setVersion(`v${v.version}${v.commit ? ` · ${v.commit}` : ""}`))
      .catch(() => undefined);
  }, []);

  const loose = conversations.filter((c) => !c.projectId);
  // A newer version next to "Updates" (checked once when the app opens).
  const [newVersion, setNewVersion] = useState("");
  useEffect(() => {
    void api<{ newCommits: unknown[]; latestVersion?: string; version: string }>("/api/updates").then(
      (c) => setNewVersion(c.newCommits.length && c.latestVersion && c.latestVersion !== c.version ? c.latestVersion : ""),
      () => undefined,
    );
  }, []);
  const app = useAppMenu();
  const [pinned] = usePins();
  // Pinned tools in the user's own order (long press and drag to change it), from the shared menu.
  const pinnedItems = app.pinned.map((e) => ({ href: e.href!, label: e.label }));
  const pinDrag = useDragOrder(pinnedItems.map((n) => n.href), (order) => setPinOrder([...order, ...pinned.filter((h) => !order.includes(h))]));

  return (
    <nav className={`sidebar${menuOpen ? " open" : ""}`} aria-label="Main">
      <SidebarGrip />
      <QuickMenu />
      <ConversationSearch />
      {!searching && <div className="sidebar-actions">
        {/* The same main actions as every other menu (useAppMenu). */}
        {app.main.map((e) =>
          e.run ? (
            <button key={e.key} type="button" className="nav-link as-link" onClick={e.run}>
              <span className="plus" aria-hidden>{e.icon}</span> {e.label}
            </button>
          ) : (
            <a key={e.key} className={`nav-link${e.key === "new-chat" ? " new-chat" : ""}`} href={e.href} aria-current={hash === e.href ? "page" : undefined}>
              <span className={e.icon === "+" ? "plus" : "nav-ico"} aria-hidden="true">{e.icon}</span> {e.label}
            </a>
          ),
        )}
        {!editing && pinnedItems.length > 0 && (
          <div className={`nav-pins${pinDrag.dragging ? " reordering" : ""}`} title={t("dragToReorder")}>
            {pinnedItems.map((n) => (
              <a key={n.href} href={n.href} className={`nav-link nav-pin${pinDrag.dragging === n.href ? " dragging" : ""}`} aria-current={hash === n.href ? "page" : undefined} {...pinDrag.props(n.href)}>
                {NAV_ICONS[n.href] && <span className="nav-ico" aria-hidden="true"><ToolIcon href={n.href} fallback={NAV_ICONS[n.href]!} /></span>} {n.label}
              </a>
            ))}
          </div>
        )}
      </div>}

      <div className="sidebar-scroll">
        {!searching && editing && <SidebarEdit onDone={() => setEditing(false)} />}
        {!searching && !editing && <SidebarShortcuts hash={hash} />}
        {!searching && (<>
        <div className="section-head">
          <span>{t("projects")}</span>
          <button type="button" className="icon-btn" aria-label={t("newProject")} onClick={() => setDialog("project")}>
            +
          </button>
        </div>
        {projects.map((p) => {
          const items = conversations.filter((c) => c.projectId === p.id);
          const expanded = open[p.id] ?? items.some((c) => c.id === activeId);
          return (
            <div key={p.id}>
              <button type="button" className="project-btn" aria-expanded={expanded} onClick={() => setOpen({ ...open, [p.id]: !expanded })}>
                <span aria-hidden="true">{expanded ? "▾" : "▸"}</span> {p.name}
              </button>
              {expanded && (
                <div className="project-items">
                  <button
                    type="button"
                    className="link-btn"
                    onClick={() => void createConversation({ kind: p.workspace ? "code" : "chat", projectId: p.id }).catch((e: Error) => toast(e.message))}
                  >
                    + {p.workspace ? t("newCode") : t("newChat")}
                  </button>
                  {items.map((c) => (
                    <ConversationLink key={c.id} c={c} active={c.id === activeId} />
                  ))}
                </div>
              )}
            </div>
          );
        })}

        <div className="section-head">
          <span>{t("recents")}</span>
        </div>
        {loose.length === 0 && <p className="muted" style={{ padding: "0 12px" }}>{t("noConversations")}</p>}
        {loose.map((c) => (
          <ConversationLink key={c.id} c={c} active={c.id === activeId} />
        ))}
        </>)}
      </div>

      <div className="sidebar-foot">
      <div className="foot-row">
        <AccountButton />
        <button type="button" className={`icon-btn foot-btn${editing ? " on" : ""}`} title={getLocale() === "he" ? "עריכת התפריט" : "Edit the menu"} aria-label={getLocale() === "he" ? "עריכת התפריט" : "Edit the menu"} aria-pressed={editing} onClick={() => setEditing(!editing)}>
          <svg width="16" height="16" viewBox="0 0 18 18" aria-hidden="true"><path d="M3 15l.7-3.2L12.2 3.3a1.4 1.4 0 0 1 2 0l.5.5a1.4 1.4 0 0 1 0 2L6.2 14.3z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" fill="none" /></svg>
        </button>
        <a className="icon-btn foot-btn" href="#/updates" title={t("updatesNav")} aria-label={t("updatesNav")}>⬆{newVersion && <span className="update-dot" aria-hidden="true">●</span>}</a>
        <button type="button" className="icon-btn foot-btn" title={t("language")} aria-label={t("language")} onClick={() => { setLocale(getLocale() === "he" ? "en" : "he"); onLocale(); }}>{getLocale() === "he" ? "EN" : "ע"}</button>
        <a className="icon-btn foot-btn" href="#/settings" title={t("settings")} aria-label={t("settings")} aria-current={hash.startsWith("#/settings") ? "page" : undefined}>⚙</a>
      </div>
      <div className="brand small-brand">
        {/* The knot: two rings linked, one passing over the other. */}
        <svg width="28" height="28" viewBox="0 0 28 28" aria-hidden="true" className="knot">
          <circle cx="10" cy="14" r="6" fill="none" stroke="var(--accent)" strokeWidth="2.4" />
          <circle cx="18" cy="14" r="6" fill="none" stroke="var(--text)" strokeWidth="2.4" />
          <path d="M14.2 9.4 A6 6 0 0 1 16 14" fill="none" stroke="var(--panel)" strokeWidth="5" />
          <path d="M14.2 9.4 A6 6 0 0 1 16 14" fill="none" stroke="var(--accent)" strokeWidth="2.4" strokeLinecap="round" />
        </svg>
        <span>{branding.productName}<small dir="ltr"><span style={{ color: online ? "var(--good)" : "var(--bad)" }}>●</span> {location.host} · {version}</small></span>
      </div>

        {appHome() && (
          // Inside the Android app: the chat with a model on the phone itself.
          <button type="button" onClick={() => (location.href = `${appHome()!.replace(/\/$/, "")}/local.html?chat=1`)}>
            {t("phoneChat")}
          </button>
        )}
        {appHome() && (
          // Inside the Android app: back to its list of computers, without reconnecting.
          <button type="button" onClick={() => (location.href = `${appHome()!.replace(/\/$/, "")}/?switch=1`)}>
            {t("switchComputer")}
          </button>
        )}
        {(appHome() || isRemote()) && (
          <button type="button" className="danger" onClick={() => confirm(t("disconnectSure")) && disconnectComputer()}>
            {t("disconnectComputer")}
          </button>
        )}
        {appHome() && (
          // The app's own update check lives on its home screen.
          <button type="button" onClick={() => (location.href = `${appHome()!.replace(/\/$/, "")}/?switch=1&update=1`)}>
            {t("appUpdates")}
          </button>
        )}
      </div>
      {dialog && <NewDialog kind={dialog} onClose={() => setDialog(null)} />}
    </nav>
  );
}

let searchQuery = "";
const searchListeners = new Set<(q: string) => void>();
/** @returns Whether the sidebar's search box has text (then it shows results instead of lists). */
function useSearching(): boolean {
  const [q, setQ] = useState(searchQuery);
  useEffect(() => {
    searchListeners.add(setQ);
    return () => void searchListeners.delete(setQ);
  }, []);
  return !!q.trim();
}

interface Hit { id: string; title: string; updatedAt: string; kind: string; snippet: string; role: string }
interface KnowledgeHit { base: string; source: string; page: number; text: string }
interface DayHit { kind: string; day: string; t: number; title: string; snippet: string }
interface Results { chats: Hit[]; knowledge: KnowledgeHit[]; day: DayHit[] }

/** One search, from the sidebar: chats, knowledge bases, and "My day" with meetings. */
function ConversationSearch() {
  const [q, setQ] = useState(searchQuery);
  const [r, setR] = useState<Results | null>(null);
  useEffect(() => {
    searchQuery = q;
    for (const l of searchListeners) l(q);
    if (!q.trim()) return setR(null);
    const id = setTimeout(() => void api<Results>(`/api/search?q=${encodeURIComponent(q)}`).then(setR, () => setR({ chats: [], knowledge: [], day: [] })), 250);
    return () => clearTimeout(id);
  }, [q]);
  const none = r && !r.chats.length && !r.knowledge.length && !r.day.length;
  return (
    <div className="conv-search">
      <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("searchChats")} aria-label={t("searchChats")} onKeyDown={(e) => e.key === "Escape" && setQ("")} />
      {r && (
        <div className="conv-hits">
          {none && <p className="muted small">{t("searchNone")}</p>}
          {r.chats.length > 0 && <span className="conv-hits-head">{t("searchInChats")}</span>}
          {r.chats.map((h) => (
            <a key={h.id} className="conv-hit" href={`#/c/${h.id}`}>
              <span className="conv-hit-title" dir="auto">{h.kind === "code" ? "</> " : ""}{h.title}</span>
              <span className="muted small" dir="auto">{h.snippet}</span>
            </a>
          ))}
          {r.knowledge.length > 0 && <span className="conv-hits-head">{t("knowledgeNav")}</span>}
          {r.knowledge.map((h, i) => (
            <a key={`k${i}`} className="conv-hit" href="#/knowledge">
              <span className="conv-hit-title" dir="auto">{h.source}{/^https?:/.test(h.source) ? "" : `, p. ${h.page}`}</span>
              <span className="muted small" dir="auto">{h.text}</span>
            </a>
          ))}
          {r.day.length > 0 && <span className="conv-hits-head">{t("dayNav")}</span>}
          {r.day.map((h, i) => (
            <a key={`d${i}`} className="conv-hit" href="#/day">
              <span className="conv-hit-title" dir="auto">{h.title}</span>
              <span className="muted small" dir="auto">{h.day} · {h.snippet}</span>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

const SIDE_MIN = 200;
const SIDE_MAX = 520;

/** Sets the sidebar's width (kept for next time). */
function setSideWidth(px: number | null) {
  if (px === null) document.documentElement.style.removeProperty("--side-w");
  else document.documentElement.style.setProperty("--side-w", `${Math.round(px)}px`);
}
try {
  const saved = Number(localStorage.getItem("kesher.sideWidth"));
  if (saved >= SIDE_MIN && saved <= SIDE_MAX) setSideWidth(saved);
} catch {
  // the usual width
}

/**
 * The sidebar's edge, dragged with the mouse to make it wider or narrower (200-520 px, kept for next time);
 * double-click or Home puts back the usual width; arrow keys move it too.
 */
function SidebarGrip() {
  const save = (px: number | null) => {
    setSideWidth(px);
    try {
      if (px === null) localStorage.removeItem("kesher.sideWidth");
      else localStorage.setItem("kesher.sideWidth", String(Math.round(px)));
    } catch {
      // only for this visit
    }
  };
  const width = () => (document.querySelector(".sidebar") as HTMLElement | null)?.getBoundingClientRect().width ?? 264;
  // The sidebar is at the start of the row: on the right in a right-to-left page.
  const sign = () => (getComputedStyle(document.documentElement).direction === "rtl" ? -1 : 1);
  const start = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const x0 = e.clientX;
    const w0 = width();
    let last = w0;
    const move = (ev: PointerEvent) => {
      last = Math.min(SIDE_MAX, Math.max(SIDE_MIN, w0 + (ev.clientX - x0) * sign()));
      setSideWidth(last);
    };
    const end = () => {
      removeEventListener("pointermove", move);
      removeEventListener("pointerup", end);
      document.body.style.removeProperty("cursor");
      save(last);
    };
    document.body.style.cursor = "col-resize";
    addEventListener("pointermove", move);
    addEventListener("pointerup", end);
  };
  return (
    <div
      className="sidebar-grip"
      role="separator"
      aria-orientation="vertical"
      aria-label={getLocale() === "he" ? "שינוי רוחב סרגל הצד" : "Resize the sidebar"}
      tabIndex={0}
      onPointerDown={start}
      onDoubleClick={() => save(null)}
      onKeyDown={(e) => {
        if (e.key === "Home") return save(null);
        const step = e.key === "ArrowRight" ? 16 : e.key === "ArrowLeft" ? -16 : 0;
        if (step) save(Math.min(SIDE_MAX, Math.max(SIDE_MIN, width() + step * sign())));
      }}
    />
  );
}

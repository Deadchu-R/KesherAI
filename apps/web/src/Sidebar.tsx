import { useEffect, useState } from "react";
import { branding, type ConversationSummary } from "@kesher/shared";
import { api, appHome } from "./api";
import { createConversation, desktop, refreshLibrary, toast, useActivity, useLibrary } from "./library";
import { getLocale, setLocale, t } from "./i18n";
import { NEW_CODE_EVENT } from "./AppBar";
import { usePluginUi } from "./plugins";
import { QuickMenu } from "./QuickMenu";
import { AccountButton } from "./AccountButton";

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
            <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              <option value="">{t("noProject")}</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
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
  return (
    <a href={`#/c/${c.id}`} className="nav-link conv-link" aria-current={active ? "page" : undefined} title={c.title}>
      <span className="conv-kind" aria-hidden="true">
        {c.kind === "code" ? "</>" : "•"}
      </span>
      <span className="conv-title">{c.title}</span>
      {state && <span className={`conv-live ${state}`} title={state === "running" ? t("convRunning") : t("convWaiting")} aria-label={state === "running" ? t("convRunning") : t("convWaiting")} />}
    </a>
  );
}

/** The left sidebar: new buttons, projects with their conversations, other screens. */
export function Sidebar({ hash, online, open: menuOpen, onLocale }: { hash: string; online: boolean | null; open: boolean; onLocale: () => void }) {
  const { projects, conversations } = useLibrary();
  const [dialog, setDialog] = useState<"code" | "project" | null>(null);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const searching = useSearching();
  const [version, setVersion] = useState("");
  const activeId = hash.startsWith("#/c/") ? hash.slice(4) : "";
  const pluginPages = usePluginUi().pages;

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
  const nav: Array<[string, Parameters<typeof t>[0]]> = [
    ["#/day", "dayNav"],
    ["#/compare", "compareNav"],
    ["#/knowledge", "knowledgeNav"],
    ["#/personas", "personasNav"],
    ["#/memory", "memoryNav"],
    ["#/prompts", "promptsNav"],
    ["#/pipelines", "pipelinesNav"],
    ["#/watch", "watchNav"],
    ["#/images", "images"],
    ["#/batch", "batchNav"],
    ["#/nodes", "nodesNav"],
    ["#/models", "models"],
    ["#/connections", "connections"],
    ["#/usage", "usageNav"],
    ["#/community", "communityNav"],
    ["#/plugins", "pluginsNav"],
    ["#/updates", "updatesNav"],
    ["#/settings", "settings"],
  ];

  return (
    <nav className={`sidebar${menuOpen ? " open" : ""}`} aria-label="Main">
      <QuickMenu />
      <ConversationSearch />
      {!searching && <div className="sidebar-actions">
        <a className="nav-link new-chat" href="#/" aria-current={hash === "#/" ? "page" : undefined}>
          <span className="plus" aria-hidden>+</span> {t("newChat")}
        </a>
        <button type="button" className="nav-link as-link" onClick={() => setDialog("code")}>
          <span className="plus" aria-hidden>{"</>"}</span> {t("newCode")}
        </button>
        {nav.map(([h, label]) => (
          <a key={h} href={h} className="nav-link" aria-current={hash === h ? "page" : undefined}>
            {t(label)}
            {h === "#/updates" && newVersion && <span className="update-dot" title={t("updateAvailable", { n: 1 })}> v{newVersion}</span>}
          </a>
        ))}
        {pluginPages.map((p) => {
          const h = `#/p/${p.pluginId}/${p.id}`;
          return (
            <a key={h} href={h} className="nav-link plugin-nav" aria-current={hash === h ? "page" : undefined}>
              {p.icon && <span aria-hidden="true">{p.icon} </span>}
              {p.title}
            </a>
          );
        })}
      </div>}

      <div className="sidebar-scroll">
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
      <AccountButton />
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

        <button
          type="button"
          onClick={() => {
            setLocale(getLocale() === "he" ? "en" : "he");
            onLocale();
          }}
        >
          {t("language")}
        </button>
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

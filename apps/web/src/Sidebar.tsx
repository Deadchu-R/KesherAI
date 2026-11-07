import { useEffect, useState } from "react";
import { branding, type ConversationSummary } from "@kesher/shared";
import { api, appHome } from "./api";
import { createConversation, desktop, refreshLibrary, toast, useLibrary } from "./library";
import { getLocale, setLocale, t } from "./i18n";
import { NEW_CODE_EVENT } from "./AppBar";

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
  return (
    <a href={`#/c/${c.id}`} className="nav-link conv-link" aria-current={active ? "page" : undefined} title={c.title}>
      <span className="conv-kind" aria-hidden="true">
        {c.kind === "code" ? "</>" : "•"}
      </span>
      <span className="conv-title">{c.title}</span>
    </a>
  );
}

/** The left sidebar: new buttons, projects with their conversations, other screens. */
export function Sidebar({ hash, online, open: menuOpen, onLocale }: { hash: string; online: boolean | null; open: boolean; onLocale: () => void }) {
  const { projects, conversations } = useLibrary();
  const [dialog, setDialog] = useState<"code" | "project" | null>(null);
  const [open, setOpen] = useState<Record<string, boolean>>({});
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
  const nav: Array<[string, Parameters<typeof t>[0]]> = [
    ["#/images", "images"],
    ["#/models", "models"],
    ["#/connections", "connections"],
    ["#/settings", "settings"],
  ];

  return (
    <nav className={`sidebar${menuOpen ? " open" : ""}`} aria-label="Main">
      <div className="sidebar-actions">
        <a className="nav-link new-chat" href="#/" aria-current={hash === "#/" ? "page" : undefined}>
          <span className="plus" aria-hidden>+</span> {t("newChat")}
        </a>
        <button type="button" className="nav-link as-link" onClick={() => setDialog("code")}>
          <span className="plus" aria-hidden>{"</>"}</span> {t("newCode")}
        </button>
        {nav.map(([h, label]) => (
          <a key={h} href={h} className="nav-link" aria-current={hash === h ? "page" : undefined}>
            {t(label)}
          </a>
        ))}
      </div>

      <div className="sidebar-scroll">
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
      </div>

      <div className="sidebar-foot">
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

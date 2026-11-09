import { useEffect, useRef, useState } from "react";
import type { PermissionMode } from "@kesher/shared";
import { api } from "./api";
import { getLocale, t } from "./i18n";

const L = (he: string, en: string) => (getLocale() === "he" ? he : en);

/** What the menu can do in the conversation that owns it. */
export interface AddMenuProps {
  /** Pick files (desktop dialog, or upload from a browser/phone). */
  onFiles: () => void;
  /** Take a photo (phone camera) or pick a picture. */
  onPhoto: () => void;
  /** A folder chosen in the computer's dialog (the desktop app only). */
  onProject?: () => void;
  /** Adds one of the Unity/Unreal projects found on the computer (works from the phone too). */
  onGameProject?: (path: string) => void;
  /** The chat, for finding scripts in its folders. */
  convId?: string;
  /** Adds a script found in the chat's folders. */
  onScript?: (path: string) => void;
  /** Mark up a picture (the computer's screen, or one from this device) before it goes to the chat. */
  onAnnotate?: (from: "screen" | "file") => void;
  /** Adds text to the message box. */
  onInsert: (text: string) => void;
  web: boolean;
  onWeb: (on: boolean) => void;
  /** The chat's approvals mode (a box with no chat yet has none). */
  mode?: PermissionMode;
  onMode?: (mode: PermissionMode) => void;
}

type Sub = "pages" | "chats" | "knowledge" | "skills" | "approvals" | "projects" | "scripts" | null;
interface Named { id: string; name?: string; title?: string; description?: string }

/**
 * The message box's +, modelled on the big apps (researched first): Gemini
 * splits "add" (uploads) from "tools" with a divider and puts rarer ones in
 * flyouts; ChatGPT groups by intent (attach, create, research) and shows a
 * removable chip for a chosen mode; Claude keeps one list with flyouts for
 * skills and connectors. KesherAI: things to add on top (files, photo, a
 * page, another chat, a project), then tools (web search, research,
 * knowledge, skills, approvals), then places to set things up (connectors,
 * memory, devices). Flyouts open in place, so it works the same by finger.
 */
export function AddMenu(p: AddMenuProps) {
  const [open, setOpen] = useState(false);
  const [sub, setSub] = useState<Sub>(null);
  const [items, setItems] = useState<Named[] | null>(null);
  const [games, setGames] = useState<Array<{ kind: string; name: string; path: string; engine?: string }> | null>(null);
  const [scriptQ, setScriptQ] = useState("");
  const [scripts, setScripts] = useState<{ roots: string[]; scripts: Array<{ path: string; rel: string }> } | null>(null);
  // Scripts: searched as you type (a short pause first).
  useEffect(() => {
    if (sub !== "scripts" || !p.convId) return;
    const t = setTimeout(() => void api<{ roots: string[]; scripts: Array<{ path: string; rel: string }> }>(`/api/conversations/${p.convId}/scripts?q=${encodeURIComponent(scriptQ)}`).then(setScripts, () => setScripts({ roots: [], scripts: [] })), 250);
    return () => clearTimeout(t);
  }, [sub, scriptQ, p.convId]);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      if (!ref.current?.contains(e.target as Node)) {
        setOpen(false);
        setSub(null);
      }
    };
    addEventListener("mousedown", close);
    return () => removeEventListener("mousedown", close);
  }, [open]);
  const done = () => {
    setOpen(false);
    setSub(null);
  };
  // A flyout's list, loaded when it opens.
  const openSub = (s: Sub) => {
    if (sub === s) return setSub(null);
    setSub(s);
    setItems(null);
    const load: Record<string, () => Promise<Named[]>> = {
      pages: () => api<Named[] | { pages: Named[] }>("/api/pages").then((r) => (Array.isArray(r) ? r : r.pages)),
      chats: () => api<Named[] | { conversations: Named[] }>("/api/conversations").then((r) => (Array.isArray(r) ? r : r.conversations)),
      knowledge: () => api<{ bases: Named[] }>("/api/knowledge").then((r) => r.bases),
      skills: () => api<{ skills: Named[] } | Named[]>("/api/skills").then((r) => (Array.isArray(r) ? r : r.skills)),
    };
    if (s && load[s]) void load[s]().then((x) => setItems((x ?? []).slice(0, 30)), () => setItems([]));
    if (s === "projects") {
      setGames(null);
      void api<{ projects: Array<{ kind: string; name: string; path: string; engine?: string }> }>("/api/game-projects").then((r) => setGames(r.projects), () => setGames([]));
    }
    if (s === "scripts") {
      setScripts(null);
      setScriptQ("");
    }
  };
  const insertPage = async (id: string, title: string) => {
    const page = await api<{ title?: string; content?: string }>(`/api/pages/${encodeURIComponent(id)}`).catch(() => null);
    const text = (page?.content ?? "").slice(0, 6000);
    p.onInsert(`[${L("דף", "Page")}: ${title}]\n${text}${(page?.content?.length ?? 0) > 6000 ? "\n…" : ""}\n`);
    done();
  };
  const insertChat = async (id: string, title: string) => {
    const c = await api<{ events?: Array<{ type: string; text?: string }> }>(`/api/conversations/${encodeURIComponent(id)}`).catch(() => null);
    const last = [...(c?.events ?? [])].reverse().find((e) => e.type === "assistant")?.text ?? "";
    p.onInsert(`[${L("מהשיחה", "From the chat")} "${title}"]\n${last.slice(0, 4000)}\n`);
    done();
  };
  const modes: Array<[PermissionMode, string]> = [
    ["plan", t("modePlan")],
    ["ask", t("modeAsk")],
    ["auto-edit", t("modeAutoEdit")],
    ["auto", t("modeAuto")],
  ];
  const list = (render: (x: Named) => React.ReactNode) =>
    items === null ? <p className="muted small add-sub-note">…</p> : items.length === 0 ? <p className="muted small add-sub-note">{L("אין עדיין", "None yet")}</p> : items.map(render);
  return (
    <div className="model-menu add-menu" ref={ref}>
      <button type="button" className="chip" title={t("attachHint")} aria-label={t("attach")} aria-haspopup="menu" aria-expanded={open} onClick={() => (open ? done() : setOpen(true))}>+</button>
      {open && (
        <div className="model-pop add-pop" role="menu">
          <button type="button" role="menuitem" onClick={() => { done(); p.onFiles(); }}>📎 {L("קבצים…", "Files…")}</button>
          <button type="button" role="menuitem" onClick={() => { done(); p.onPhoto(); }}>📷 {L("מצלמה או תמונה", "Camera or photo")}</button>
          {p.onAnnotate && (
            <>
              <button type="button" role="menuitem" onClick={() => { done(); p.onAnnotate!("screen"); }}>✏️ {L("צילום מסך של המחשב + סימון", "The computer's screen + mark it up")}</button>
              <button type="button" role="menuitem" onClick={() => { done(); p.onAnnotate!("file"); }}>🖍 {L("סימון על תמונה", "Mark up a picture")}</button>
            </>
          )}
          <button type="button" role="menuitem" aria-expanded={sub === "pages"} onClick={() => openSub("pages")}>📄 {L("מסמך מהדפים", "A document from Pages")} <span className="sub-arrow">›</span></button>
          {sub === "pages" && <div className="add-sub">{list((x) => <button key={x.id} type="button" role="menuitem" dir="auto" onClick={() => void insertPage(x.id, x.title ?? x.name ?? "")}>{x.title ?? x.name}</button>)}</div>}
          <button type="button" role="menuitem" aria-expanded={sub === "chats"} onClick={() => openSub("chats")}>💬 {L("משיחה אחרת", "From another chat")} <span className="sub-arrow">›</span></button>
          {sub === "chats" && <div className="add-sub">{list((x) => <button key={x.id} type="button" role="menuitem" dir="auto" onClick={() => void insertChat(x.id, x.title ?? "")}>{x.title}</button>)}</div>}
          {(p.onGameProject || p.onProject) && <button type="button" role="menuitem" aria-expanded={sub === "projects"} onClick={() => openSub("projects")}>🎮 {L("פרויקט Unity או Unreal", "A Unity or Unreal project")} <span className="sub-arrow">›</span></button>}
          {sub === "projects" && (
            <div className="add-sub">
              {games === null ? <p className="muted small add-sub-note">…</p> : games.length === 0 ? <p className="muted small add-sub-note">{L("לא נמצאו פרויקטים במחשב.", "No projects found on the computer.")}</p> : games.map((g) => (
                <button key={g.path} type="button" role="menuitem" dir="auto" title={g.path} onClick={() => { done(); p.onGameProject?.(g.path); }}>
                  {g.kind === "unity" ? "◼ Unity" : "◆ Unreal"} · {g.name}{g.engine ? <span className="muted small"> {g.engine}</span> : null}
                </button>
              ))}
              {p.onProject && <button type="button" role="menuitem" onClick={() => { done(); p.onProject!(); }}>📁 {L("תיקייה אחרת…", "Another folder…")}</button>}
            </div>
          )}
          {p.onScript && p.convId && <button type="button" role="menuitem" aria-expanded={sub === "scripts"} onClick={() => openSub("scripts")}>📜 {L("סקריפט מהפרויקט", "A script from the project")} <span className="sub-arrow">›</span></button>}
          {sub === "scripts" && (
            <div className="add-sub">
              <input className="add-sub-search" dir="auto" autoFocus value={scriptQ} onChange={(e) => setScriptQ(e.target.value)} placeholder={L("חיפוש: Player, Door.cpp…", "Find: Player, Door.cpp…")} aria-label={L("חיפוש סקריפט", "Find a script")} />
              {scripts === null ? <p className="muted small add-sub-note">…</p> : !scripts.roots.length ? <p className="muted small add-sub-note">{L("קודם הוסיפו פרויקט לצ'אט (🎮 למעלה).", "Add a project to the chat first (🎮 above).")}</p> : scripts.scripts.length === 0 ? <p className="muted small add-sub-note">{L("לא נמצא.", "Nothing found.")}</p> : scripts.scripts.map((x) => (
                <button key={x.path} type="button" role="menuitem" dir="ltr" title={x.path} onClick={() => { p.onScript!(x.path); done(); }}>{x.rel}</button>
              ))}
            </div>
          )}
          <hr />
          <button type="button" role="menuitemcheckbox" aria-checked={p.web} onClick={() => p.onWeb(!p.web)}>🌐 {L("חיפוש באינטרנט", "Web search")} <span className="sub-arrow">{p.web ? "✓" : ""}</span></button>
          <button type="button" role="menuitem" onClick={() => { p.onWeb(true); p.onInsert(L("מחקר מעמיק: חפש כמה פעמים, השווה בין מקורות, וצטט כל מקור.\n", "Deep research: search several times, compare sources, and cite each one.\n")); done(); }}>🔬 {L("מחקר מעמיק", "Deep research")}</button>
          <button type="button" role="menuitem" aria-expanded={sub === "knowledge"} onClick={() => openSub("knowledge")}>📚 {L("ידע וספריות", "Knowledge and libraries")} <span className="sub-arrow">›</span></button>
          {sub === "knowledge" && <div className="add-sub">{list((x) => <button key={x.id} type="button" role="menuitem" dir="auto" onClick={() => { p.onInsert(`${L("חפש בבסיס הידע", "Search the knowledge base")} "${x.name}": `); done(); }}>{x.name}</button>)}<a className="add-sub-link small" href="#/libraries" onClick={done}>📦 {L("חנות ספריות", "Library store")}</a></div>}
          <button type="button" role="menuitem" aria-expanded={sub === "skills"} onClick={() => openSub("skills")}>🧩 {L("סקילים", "Skills")} <span className="sub-arrow">›</span></button>
          {sub === "skills" && <div className="add-sub">{list((x) => <button key={x.id ?? x.name} type="button" role="menuitem" dir="auto" title={x.description} onClick={() => { p.onInsert(`${L("השתמש בסקיל", "Use the skill")} "${x.name}": `); done(); }}>{x.name}</button>)}</div>}
          {p.onMode && <button type="button" role="menuitem" aria-expanded={sub === "approvals"} onClick={() => openSub("approvals")}>✅ {L("אישורים", "Approvals")} <span className="sub-arrow">›</span></button>}
          {p.onMode && sub === "approvals" && <div className="add-sub">{modes.map(([m, label]) => <button key={m} type="button" role="menuitemradio" aria-checked={p.mode === m} onClick={() => { p.onMode!(m); done(); }}>{p.mode === m ? "● " : "○ "}{label}</button>)}</div>}
          <hr />
          <a role="menuitem" href="#/connections" onClick={done}>🔌 {L("קונקטורים ומכשירים", "Connectors and devices")}</a>
          <a role="menuitem" href="#/memory" onClick={done}>🧠 {L("זיכרונות", "Memory")}</a>
        </div>
      )}
    </div>
  );
}

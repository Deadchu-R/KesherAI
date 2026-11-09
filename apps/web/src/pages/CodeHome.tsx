import { useEffect, useMemo, useRef, useState } from "react";
import { ComposerBar } from "../ComposerBar";
import { useChatAttach } from "../ChatAttach";
import { useWebSearch } from "../WebToggle";
import { PromptTextarea, expandSlash } from "../SlashMenu";
import { api } from "../api";
import { getLocale } from "../i18n";
import { createConversation, desktop, refreshLibrary, toast, useLibrary } from "../library";
import { useModels } from "../useModels";

const L = (he: string, en: string) => (getLocale() === "he" ? he : en);

/** The folder's last part, for a short chip ("C:\\Code\\Game" → "Game"). */
const short = (path: string) => path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || path;

/**
 * The code start screen (the </> switch at the top), like the Code side of
 * the Claude app: one message box with the folder to work in as a chip
 * (your recent folders first, or another one), and your recent code
 * sessions below. Writing there starts the session in that folder — no
 * dialog. Works the same from the phone app (folders are typed or picked
 * from the recent ones; the computer runs the session).
 */
export function CodeHome() {
  const { conversations, projects } = useLibrary();
  const { models } = useModels("chat");
  const [modelId, setModelId] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  // Folders used before: code sessions' folders and projects' folders, newest first.
  const recent = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const c of conversations) {
      const f = c.kind === "code" ? c.workspace ?? projects.find((p) => p.id === c.projectId)?.workspace : undefined;
      if (f && !seen.has(f)) {
        seen.add(f);
        out.push(f);
      }
    }
    for (const p of projects) {
      if (p.workspace && !seen.has(p.workspace)) {
        seen.add(p.workspace);
        out.push(p.workspace);
      }
    }
    return out.slice(0, 8);
  }, [conversations, projects]);
  const [folder, setFolder] = useState(() => {
    try {
      return localStorage.getItem("kesher.codeFolder") ?? "";
    } catch {
      return "";
    }
  });
  const [typing, setTyping] = useState(false);
  const setDraftIdRef = useRef<((v: string | undefined) => void) | undefined>(undefined);
  useEffect(() => {
    if (!folder && recent[0]) setFolder(recent[0]);
  }, [recent]);
  useEffect(() => {
    void api<{ activeModels: Record<string, string> }>("/api/settings").then((s) => setModelId((m) => m || s.activeModels.code || s.activeModels.chat || ""), () => undefined);
  }, []);
  const choose = (f: string) => {
    // Another folder: the next attachment makes a new session there.
    if (f !== folder) setDraftIdRef.current?.(undefined);
    setFolder(f);
    setTyping(false);
    try {
      localStorage.setItem("kesher.codeFolder", f);
    } catch {
      // private window: not remembered
    }
  };
  const [web, setWeb] = useWebSearch();
  // The same + menu as every chat box: the session is made in the chosen folder on the first thing added.
  const [draftId, setDraftId] = useState<string>();
  setDraftIdRef.current = setDraftId;
  const ensure = async () => {
    if (draftId) return draftId;
    if (!folder.trim()) {
      setTyping(true);
      toast(L("בחרו תיקייה לעבוד בה.", "Choose a folder to work in."));
      return undefined;
    }
    const id = await createConversation({ kind: "code", workspace: folder.trim(), ...(modelId ? { modelId } : {}) }, { open: false });
    if (id) setDraftId(id);
    return id;
  };
  const attachments = useChatAttach({ ensure, insert: (txt) => setText((v) => `${v}${v && !v.endsWith("\n") ? "\n" : ""}${txt}`), onError: (m) => toast(m) });
  const start = async () => {
    const value = expandSlash(text.trim());
    if (!value || busy) return;
    if (!folder.trim()) {
      setTyping(true);
      toast(L("בחרו תיקייה לעבוד בה.", "Choose a folder to work in."));
      return;
    }
    setBusy(true);
    try {
      const id = draftId ?? (await createConversation({ kind: "code", workspace: folder.trim(), ...(modelId ? { modelId } : {}) }));
      if (!id) return;
      if (draftId) location.hash = `#/c/${id}`;
      choose(folder.trim());
      await api(`/api/conversations/${id}/messages`, { method: "POST", body: { text: value, ...(web ? { web: true } : {}) } });
      void refreshLibrary().catch(() => undefined);
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const sessions = conversations.filter((c) => c.kind === "code").slice(0, 8);
  return (
    <div className="home code-home">
      <h1 className="greeting">{L("מה נבנה?", "What should we build?")}</h1>
      <form className="composer home-composer" onSubmit={(e) => { e.preventDefault(); void start(); }}>
        <div className="box">
          <PromptTextarea
            rows={3}
            autoFocus
            value={text}
            placeholder={L("תארו מה לכתוב, לתקן או לבדוק בקוד…", "Describe what to write, fix or check in the code…")}
            aria-label={L("משימת קוד", "Code task")}
            onValue={setText}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void start();
              }
            }}
          />
          {attachments.elements}
          <ComposerBar
            attach={attachments.menu}
            onInsert={(txt) => setText((v) => `${v}${v && !v.endsWith("\n") ? "\n" : ""}${txt}`)}
            web={web}
            onWeb={setWeb}
            model={{ models, value: modelId, onChange: setModelId }}
            extra={
              <>
                {typing ? (
                  <span className="row code-folder-edit">
                    <input dir="ltr" autoFocus value={folder} placeholder={L("נתיב תיקייה במחשב", "A folder on the computer")} onChange={(e) => setFolder(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); choose(folder.trim()); } }} />
                    <button type="button" onClick={() => choose(folder.trim())}>{L("אישור", "OK")}</button>
                  </span>
                ) : (
                  <select
                    className="model-chip code-folder"
                    value={folder}
                    title={folder}
                    aria-label={L("התיקייה לעבוד בה", "The folder to work in")}
                    onChange={(e) => {
                      const v = e.target.value;
                      if (v === "\u0000pick") void desktop()!.pickFolder().then((f) => f && choose(f));
                      else if (v === "\u0000type") setTyping(true);
                      else choose(v);
                    }}
                  >
                    {!folder && <option value="">{L("📁 בחרו תיקייה", "📁 Choose a folder")}</option>}
                    {folder && !recent.includes(folder) && <option value={folder}>📁 {short(folder)}</option>}
                    {recent.map((f) => <option key={f} value={f}>📁 {short(f)}</option>)}
                    {desktop()?.pickFolder && <option value={"\u0000pick"}>{L("עיון…", "Browse…")}</option>}
                    <option value={"\u0000type"}>{L("הקלדת נתיב…", "Type a path…")}</option>
                  </select>
                )}
              </>
            }
            send={<button type="submit" className="primary send" disabled={!text.trim() || busy} aria-label={L("התחל", "Start")}>↑</button>}
          />
        </div>
      </form>
      {folder && !typing && <p className="muted small code-where" dir="ltr">{folder}</p>}
      {sessions.length > 0 && (
        <section className="code-recent">
          <h2 className="small muted">{L("סשנים אחרונים", "Recent sessions")}</h2>
          <ul>
            {sessions.map((c) => (
              <li key={c.id}>
                <a href={`#/c/${c.id}`}>
                  <span className="grow" dir="auto">{c.title}</span>
                  <span className="muted small" dir="ltr">{short(c.workspace ?? projects.find((p) => p.id === c.projectId)?.workspace ?? "")}</span>
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

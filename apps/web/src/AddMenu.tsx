import { useEffect, useState } from "react";
import type { PermissionMode } from "@kesher/shared";
import { api } from "./api";
import { getLocale, t, he$ } from "./i18n";
import { Menu, MenuItem, MenuNote, MenuSeparator, MenuSub } from "./ui/Menu";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);

/** What the menu can do in the conversation that owns it. */
export interface AddMenuProps {
  /** Pick files (desktop dialog, or upload from a browser/phone). */
  onFiles: () => void;
  /** Take a photo (phone camera) or pick a picture. */
  onPhoto: () => void;
  /** A folder chosen in the computer's dialog (the desktop app only). */
  onProject?: () => void;
  /** A folder from this device (the phone, or a browser in remote), uploaded to the computer and attached. */
  onUploadFolder?: () => void;
  /** Adds one of the Unity/Unreal projects found on the computer (works from the phone too). */
  onGameProject?: (path: string) => void;
  /** The chat, for finding scripts in its folders. */
  convId?: string;
  /** A box with no chat yet (the start screen): makes the chat, so its per-chat switches (tools) work there too. */
  ensure?: () => Promise<string | undefined>;
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

type Sub = "pages" | "chats" | "knowledge" | "skills" | "approvals" | "projects" | "scripts" | "board" | "tools" | null;

/** The chat's tool switches (GET /api/conversations/:id/tool-switches). */
interface ToolSwitches {
  groups: Array<{ id: string; he: string; en: string; tools: number; on: boolean }>;
  connectors: Array<{ id: string; name: string; tools: number; on: boolean }>;
}
interface Named { id: string; name?: string; title?: string; description?: string }

type BoardCat = "normal" | "cooldown" | "fable";
interface BoardTask { id: string; title: string; details?: string; status: string; category?: BoardCat; priority: number }
const boardCat = (t: BoardTask): BoardCat => t.category ?? (/^\s*\[cool\s*down\]/i.test(t.title) ? "cooldown" : /^\s*\[fable\]/i.test(t.title) ? "fable" : "normal");

/**
 * The shared task board as a message: the open tasks of one list (or all), highest priority first, with what
 * to do with them. Plain text, so it works for any model: the local one or Antigravity (Gemini, Claude).
 */
async function boardMessage(cat: BoardCat | "all", paste = false): Promise<string> {
  // On the computer itself: the file, so the agent always reads the board as it is now (a local model with its
  // task_board tool, Antigravity with the board's folder added). Elsewhere (the phone): the tasks pasted in.
  const file = paste ? undefined : await api<{ file: string }>("/api/self-work/board/file").then((r) => r.file, () => undefined);
  if (file) {
    const which = cat === "all" ? L("כל המשימות הפתוחות", "all open tasks") : L(`המשימות הפתוחות בקטגוריה "${cat}"`, `the open tasks with category "${cat}"`);
    return `${L("לוח המשימות שלנו", "Our task board")}: ${file}\n${L(
      `קרא אותו (או השתמש בכלי task_board אם יש לך), וקח את ${which}, לפי priority (מספר נמוך קודם), אחת אחרי השנייה. סמן כל משימה כ־claimed לפני שאתה מתחיל ו־done עם ה־commit בסוף, אם אתה יכול. לכל משימה: בצע אותה, הרץ את הבדיקות (pnpm -s typecheck && pnpm -s test), ועשה commit נפרד עם הסבר. בלי push. אם משימה נכשלת פעמיים, דלג עליה וכתוב למה. בסוף תן סיכום: מה נעשה ומה לא.`,
      `Read it (or use the task_board tool if you have it), and take ${which}, by priority (lowest number first), one after another. Mark each one claimed before you start and done with the commit at the end, if you can. For each: do it, run the checks (pnpm -s typecheck && pnpm -s test), and make its own commit with an explanation. No push. If a task fails twice, skip it and say why. At the end, sum up what was done and what was not.`,
    )}\n`;
  }
  const b = await api<{ tasks: BoardTask[] }>("/api/self-work/board");
  const open = b.tasks.filter((t) => t.status === "open" && (cat === "all" || boardCat(t) === cat)).sort((x, y) => x.priority - y.priority);
  if (!open.length) return L("(אין משימות פתוחות ברשימה הזו בלוח.)\n", "(No open tasks in that list on the board.)\n");
  const list = open.map((t) => `- ${t.id} (p${t.priority}) ${t.title}${t.details ? `\n  ${t.details.replace(/\s+/g, " ").slice(0, 600)}` : ""}`).join("\n");
  return `${L("משימות מהלוח שלנו", "Tasks from our board")} (${cat === "all" ? "all" : cat}):\n${list}\n\n${L(
    "עבור עליהן אחת אחרי השנייה, לפי הסדר. לכל משימה: בצע אותה, הרץ את הבדיקות (pnpm -s typecheck && pnpm -s test), ועשה commit נפרד עם הסבר. בלי push. אם משימה נכשלת פעמיים, דלג עליה וכתוב למה. בסוף תן סיכום: מה נעשה ומה לא.",
    "Go through them one after another, in this order. For each: do it, run the checks (pnpm -s typecheck && pnpm -s test), and make its own commit with an explanation. No push. If a task fails twice, skip it and say why. At the end, sum up what was done and what was not.",
  )}\n`;
}

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
  const [switches, setSwitches] = useState<ToolSwitches | null>(null);
  // The chat the tool switches belong to: the box's own, or the one made for the start screen's box.
  const [toolsConv, setToolsConv] = useState<string>();
  const toolsChat = p.convId ?? toolsConv;
  // Scripts: searched as you type (a short pause first).
  useEffect(() => {
    if (sub !== "scripts" || !p.convId) return;
    const t = setTimeout(() => void api<{ roots: string[]; scripts: Array<{ path: string; rel: string }> }>(`/api/conversations/${p.convId}/scripts?q=${encodeURIComponent(scriptQ)}`).then(setScripts, () => setScripts({ roots: [], scripts: [] })), 250);
    return () => clearTimeout(t);
  }, [sub, scriptQ, p.convId]);
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
    if (s === "tools") {
      setSwitches(null);
      // On the start screen the chat is made now (as with the first file added), then its switches load.
      void (async () => p.convId ?? toolsConv ?? (await p.ensure?.()))().then((id) => {
        if (!id) return setSwitches({ groups: [], connectors: [] });
        setToolsConv(id);
        return api<ToolSwitches>(`/api/conversations/${encodeURIComponent(id)}/tool-switches`).then(setSwitches);
      }).catch(() => setSwitches({ groups: [], connectors: [] }));
    }
  };
  // A tool group or connector on/off for this chat only (kept with the chat; the server routes only to what is on).
  const toggleTool = (key: string) => {
    if (!switches || !toolsChat) return;
    const flip = <T extends { id: string; on: boolean }>(x: T): T => (x.id === key ? { ...x, on: !x.on } : x);
    const next = { groups: switches.groups.map(flip), connectors: switches.connectors.map(flip) };
    setSwitches(next);
    const toolsOff = [...next.groups, ...next.connectors].filter((x) => !x.on).map((x) => x.id);
    void api(`/api/conversations/${encodeURIComponent(toolsChat)}`, { method: "PATCH", body: { toolsOff } }).catch(() => setSwitches(switches));
  };
  // The board's tasks are work on the project. In a plain chat there is no project folder (found on the phone:
  // the model asked where the code is), so the board's project is granted to this chat first; the model then
  // works on it right here. A code chat already has its folder.
  const toBoard = async (c: BoardCat | "all") => {
    const conv = p.convId ? await api<{ kind?: string }>(`/api/conversations/${encodeURIComponent(p.convId)}`).catch(() => null) : null;
    if (conv && conv.kind !== "code") {
      const r = await api<{ line: string }>(`/api/conversations/${encodeURIComponent(p.convId!)}/board-project`, { method: "POST" }).catch((e: Error) => ({ line: `(${e.message})` }));
      // A plain chat has no task_board tool and the board file is outside its folders: the tasks themselves.
      const path = r.line.match(/^\[[^:]+: (.+)\]$/)?.[1];
      const where = path ? L(`הפרויקט: ${path} — עבוד בתוכו עם נתיבים מלאים (גם ב־list_files, path="${path}").`, `The project: ${path} — work inside it with full paths (also list_files, path="${path}").`) : r.line;
      return p.onInsert(`${where}\n${await boardMessage(c, true)}`);
    }
    p.onInsert(await boardMessage(c));
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
    items === null ? <MenuNote>…</MenuNote> : items.length === 0 ? <MenuNote>{L("אין עדיין", "None yet")}</MenuNote> : items.map(render);
  const subProps = (s: Exclude<Sub, null>) => ({ open: sub === s, onOpenChange: (o: boolean) => (o ? openSub(s) : setSub(null)) });
  return (
    <Menu
      className="model-menu add-menu"
      popClassName="model-pop add-pop"
      triggerClassName="chip"
      trigger="+"
      title={t("attachHint")}
      aria-label={t("attach")}
      open={open}
      onOpenChange={(o) => (o ? setOpen(true) : done())}
    >
      {/* Like Gemini and ChatGPT (RESEARCH_LOG, design PlusMenuDesktop): one "Files" for every kind of file (KesherAI
          reads documents, code, pictures, and listens to recordings and videos), a few uploads, then tools; the rest
          in "More". */}
      <MenuItem icon="📎" onSelect={p.onFiles} title={L("כל סוג: מסמכים, קוד, תמונות, וידאו, אודיו", "Any kind: documents, code, pictures, video, audio")}>{L("קבצים ותמונות", "Files and photos")}</MenuItem>
      <MenuItem icon="📷" onSelect={p.onPhoto}>{L("מצלמה או תמונה", "Camera or photo")}</MenuItem>
      {p.onAnnotate && <MenuItem icon="✏️" onSelect={() => p.onAnnotate!("screen")}>{L("צילום מסך לסימון", "Mark up the screen")}</MenuItem>}
      {(p.onGameProject || p.onProject || p.onUploadFolder) && (
        <MenuSub icon="📁" label={L("קוד או פרויקט", "Code or a project")} {...subProps("projects")}>
          {games === null ? <MenuNote>…</MenuNote> : games.length === 0 ? <MenuNote>{L("לא נמצאו פרויקטים במחשב.", "No projects found on the computer.")}</MenuNote> : games.map((g) => (
            <MenuItem key={g.path} dir="auto" title={g.path} onSelect={() => p.onGameProject?.(g.path)} end={g.engine}>
              {g.kind === "unity" ? "◼ Unity" : g.kind === "godot" ? "◇ Godot" : "◆ Unreal"} · {g.name}
            </MenuItem>
          ))}
          {p.onProject && <MenuItem icon="📁" onSelect={p.onProject}>{L("תיקייה אחרת…", "Another folder…")}</MenuItem>}
          {p.onUploadFolder && <MenuItem icon="📤" onSelect={p.onUploadFolder} title={L("נשלחת למחשב ומצורפת לצ'אט", "Sent to the computer and attached to the chat")}>{L("תיקייה מהמכשיר הזה…", "A folder from this device…")}</MenuItem>}
        </MenuSub>
      )}
      {p.onScript && p.convId && (
        <MenuSub icon="📜" label={L("סקריפט מהפרויקט", "A script from the project")} {...subProps("scripts")}>
          <input className="add-sub-search" dir="auto" autoFocus value={scriptQ} onChange={(e) => setScriptQ(e.target.value)} placeholder={L("חיפוש: Player, Door.cpp…", "Find: Player, Door.cpp…")} aria-label={L("חיפוש סקריפט", "Find a script")} />
          {scripts === null ? <MenuNote>…</MenuNote> : !scripts.roots.length ? <MenuNote>{L("קודם הוסיפו פרויקט לצ'אט (🎮 למעלה).", "Add a project to the chat first (🎮 above).")}</MenuNote> : scripts.scripts.length === 0 ? <MenuNote>{L("לא נמצא.", "Nothing found.")}</MenuNote> : scripts.scripts.map((x) => (
            <MenuItem key={x.path} dir="ltr" title={x.path} onSelect={() => p.onScript!(x.path)}>{x.rel}</MenuItem>
          ))}
        </MenuSub>
      )}
      <MenuSub icon="☁️" label={L("עוד העלאות", "More uploads")}>
        <MenuSub icon="📄" label={L("מסמך מהדפים", "A document from Pages")} {...subProps("pages")}>
          {list((x) => <MenuItem key={x.id} dir="auto" keepOpen onSelect={() => void insertPage(x.id, x.title ?? x.name ?? "")}>{x.title ?? x.name}</MenuItem>)}
        </MenuSub>
        <MenuSub icon="💬" label={L("משיחה אחרת", "From another chat")} {...subProps("chats")}>
          {list((x) => <MenuItem key={x.id} dir="auto" keepOpen onSelect={() => void insertChat(x.id, x.title ?? "")}>{x.title}</MenuItem>)}
        </MenuSub>
        <MenuSub icon="📚" label={L("ידע וספריות", "Knowledge and libraries")} {...subProps("knowledge")}>
          {list((x) => <MenuItem key={x.id} dir="auto" onSelect={() => p.onInsert(`${L("חפש בבסיס הידע", "Search the knowledge base")} "${x.name}": `)}>{x.name}</MenuItem>)}
          <MenuItem icon="📦" href="#/libraries">{L("חנות ספריות", "Library store")}</MenuItem>
        </MenuSub>
        {p.onAnnotate && <MenuItem icon="🖍" onSelect={() => p.onAnnotate!("file")}>{L("סימון על תמונה", "Mark up a picture")}</MenuItem>}
      </MenuSub>
      <MenuSeparator />
      {/* The lead plans sub-questions and runs research sub-agents at once; the report opens beside the chat (deep-research.ts). The tool's name in the text loads it. */}
      <MenuItem icon="🔬" title={L("כמה סוכני מחקר במקביל, ודוח עם מקורות שנפתח ליד הצ׳אט", "Several research agents at once, and a report with sources that opens beside the chat")} onSelect={() => p.onInsert(L("מחקר מעמיק (deep_research): ", "Research deeply (deep_research): "))}>{L("מחקר מעמיק", "Research deeply")}</MenuItem>
      {/* The chat's tools by group, and its connectors (MCP servers), each on/off for this chat (RESEARCH_LOG gap list C1, C13). */}
      {(p.convId || p.ensure) && (
        <MenuSub icon="🛠" label={L("כלים בצ'אט הזה", "Tools in this chat")} {...subProps("tools")}>
          {switches === null ? <MenuNote>…</MenuNote> : (
            <>
              {switches.groups.map((g) => (
                <MenuItem key={g.id} keepOpen checked={g.on} onSelect={() => toggleTool(g.id)}>{getLocale() === "he" ? g.he : g.en}</MenuItem>
              ))}
              {switches.connectors.length > 0 && <MenuNote>{L("קונקטורים", "Connectors")}</MenuNote>}
              {switches.connectors.map((c) => (
                <MenuItem key={c.id} keepOpen checked={c.on} dir="auto" onSelect={() => toggleTool(c.id)}>{c.name}</MenuItem>
              ))}
              <MenuNote>{L("כבוי = הצ'אט לא ישתמש בהם.", "Off = this chat won't use them.")}</MenuNote>
            </>
          )}
        </MenuSub>
      )}
      <MenuSub icon="🧰" label={L("עוד כלים", "More tools")}>
        <MenuSub icon="📋" label={L("משימות מהלוח", "Tasks from the board")} {...subProps("board")}>
          {([["normal", "🧠 Normal"], ["cooldown", "🧊 CoolDown"], ["fable", "✨ Fable"], ["all", L("הכל", "All")]] as const).map(([c, label]) => (
            <MenuItem key={c} keepOpen onSelect={() => void toBoard(c).then(done, (e: Error) => { p.onInsert(`(${e.message})\n`); done(); })}>{label}</MenuItem>
          ))}
        </MenuSub>
        <MenuSub icon="🧩" label={L("סקילים", "Skills")} {...subProps("skills")}>
          {list((x) => <MenuItem key={x.id ?? x.name} dir="auto" title={x.description} onSelect={() => p.onInsert(`${L("השתמש בסקיל", "Use the skill")} "${x.name}": `)}>{x.name}</MenuItem>)}
        </MenuSub>
        {p.onMode && (
          <MenuSub icon="✅" label={L("אישורים", "Approvals")} {...subProps("approvals")}>
            {modes.map(([m, label]) => <MenuItem key={m} kind="radio" checked={p.mode === m} onSelect={() => p.onMode!(m)}>{label}</MenuItem>)}
          </MenuSub>
        )}
        <MenuItem icon="🔌" href="#/connections">{L("קונקטורים ומכשירים", "Connectors and devices")}</MenuItem>
        <MenuItem icon="🧠" href="#/memory">{L("זיכרונות", "Memory")}</MenuItem>
      </MenuSub>
    </Menu>
  );
}

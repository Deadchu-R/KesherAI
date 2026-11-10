import { useEffect, useState } from "react";
import type { PermissionMode } from "@kesher/shared";
import { api } from "./api";
import { createConversation } from "./library";
import { openWithDraft } from "./phone";
import { getLocale, t } from "./i18n";
import { Menu, MenuItem, MenuNote, MenuSeparator, MenuSub } from "./ui/Menu";

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

type Sub = "pages" | "chats" | "knowledge" | "skills" | "approvals" | "projects" | "scripts" | "board" | null;
interface Named { id: string; name?: string; title?: string; description?: string }

type BoardCat = "normal" | "cooldown" | "fable";
interface BoardTask { id: string; title: string; details?: string; status: string; category?: BoardCat; priority: number }
const boardCat = (t: BoardTask): BoardCat => t.category ?? (/^\s*\[cool\s*down\]/i.test(t.title) ? "cooldown" : /^\s*\[fable\]/i.test(t.title) ? "fable" : "normal");

/**
 * The shared task board as a message: the open tasks of one list (or all), highest priority first, with what
 * to do with them. Plain text, so it works for any model: the local one or Antigravity (Gemini, Claude).
 */
async function boardMessage(cat: BoardCat | "all"): Promise<string> {
  // On the computer itself: the file, so the agent always reads the board as it is now (a local model with its
  // task_board tool, Antigravity with the board's folder added). Elsewhere (the phone): the tasks pasted in.
  const file = await api<{ file: string }>("/api/self-work/board/file").then((r) => r.file, () => undefined);
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
  };
  // The board's tasks are work on the project. In a plain chat there is no project folder (found on the phone:
  // the model asked where the code is), so they go to a new code chat in self-work's project, same model,
  // ready to send. A code chat (or no project known yet) gets them here.
  const toBoard = async (c: BoardCat | "all") => {
    const text = await boardMessage(c);
    const conv = p.convId ? await api<{ kind?: string; modelId?: string }>(`/api/conversations/${encodeURIComponent(p.convId)}`).catch(() => null) : null;
    if (conv && conv.kind !== "code") {
      // Self-work's project, else the folder of the latest code chat.
      const repo =
        (await api<{ run?: { repo?: string } | null }>("/api/self-work").then((r) => r.run?.repo, () => undefined)) ??
        (await api<Array<{ kind?: string; workspace?: string; updatedAt?: string }> | { conversations: Array<{ kind?: string; workspace?: string; updatedAt?: string }> }>("/api/conversations").then(
          (r) => (Array.isArray(r) ? r : r.conversations).filter((x) => x.kind === "code" && x.workspace).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))[0]?.workspace,
          () => undefined,
        ));
      if (repo) {
        const id = await createConversation({ kind: "code", workspace: repo, ...(conv.modelId ? { modelId: conv.modelId } : {}) }, { open: false });
        if (id) return openWithDraft(id, text);
      }
      return p.onInsert(`${text}\n${L("(שים לב: זו לא שיחת קוד. פתח שיחת קוד בתיקיית הפרויקט כדי שהמודל יגיע לקוד.)", "(Note: this is not a code chat. Open a code chat in the project's folder so the model can reach the code.)")}\n`);
    }
    p.onInsert(text);
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
      <MenuItem icon="📎" onSelect={p.onFiles}>{L("קבצים…", "Files…")}</MenuItem>
      <MenuItem icon="📷" onSelect={p.onPhoto}>{L("מצלמה או תמונה", "Camera or photo")}</MenuItem>
      {p.onAnnotate && (
        <>
          <MenuItem icon="✏️" onSelect={() => p.onAnnotate!("screen")}>{L("צילום מסך של המחשב + סימון", "The computer's screen + mark it up")}</MenuItem>
          <MenuItem icon="🖍" onSelect={() => p.onAnnotate!("file")}>{L("סימון על תמונה", "Mark up a picture")}</MenuItem>
        </>
      )}
      <MenuSub icon="📄" label={L("מסמך מהדפים", "A document from Pages")} {...subProps("pages")}>
        {list((x) => <MenuItem key={x.id} dir="auto" keepOpen onSelect={() => void insertPage(x.id, x.title ?? x.name ?? "")}>{x.title ?? x.name}</MenuItem>)}
      </MenuSub>
      <MenuSub icon="💬" label={L("משיחה אחרת", "From another chat")} {...subProps("chats")}>
        {list((x) => <MenuItem key={x.id} dir="auto" keepOpen onSelect={() => void insertChat(x.id, x.title ?? "")}>{x.title}</MenuItem>)}
      </MenuSub>
      {(p.onGameProject || p.onProject) && (
        <MenuSub icon="🎮" label={L("פרויקט Unity או Unreal", "A Unity or Unreal project")} {...subProps("projects")}>
          {games === null ? <MenuNote>…</MenuNote> : games.length === 0 ? <MenuNote>{L("לא נמצאו פרויקטים במחשב.", "No projects found on the computer.")}</MenuNote> : games.map((g) => (
            <MenuItem key={g.path} dir="auto" title={g.path} onSelect={() => p.onGameProject?.(g.path)} end={g.engine}>
              {g.kind === "unity" ? "◼ Unity" : "◆ Unreal"} · {g.name}
            </MenuItem>
          ))}
          {p.onProject && <MenuItem icon="📁" onSelect={p.onProject}>{L("תיקייה אחרת…", "Another folder…")}</MenuItem>}
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
      <MenuSeparator />
      <MenuItem icon="🌐" checked={p.web} keepOpen onSelect={() => p.onWeb(!p.web)}>{L("חיפוש באינטרנט", "Web search")}</MenuItem>
      <MenuItem icon="🔬" onSelect={() => { p.onWeb(true); p.onInsert(L("מחקר מעמיק: חפש כמה פעמים, השווה בין מקורות, וצטט כל מקור.\n", "Deep research: search several times, compare sources, and cite each one.\n")); }}>{L("מחקר מעמיק", "Deep research")}</MenuItem>
      <MenuSub icon="📋" label={L("משימות מהלוח", "Tasks from the board")} {...subProps("board")}>
        {([["normal", "🧠 Normal"], ["cooldown", "🧊 CoolDown"], ["fable", "✨ Fable"], ["all", L("הכל", "All")]] as const).map(([c, label]) => (
          <MenuItem key={c} keepOpen onSelect={() => void toBoard(c).then(done, (e: Error) => { p.onInsert(`(${e.message})\n`); done(); })}>{label}</MenuItem>
        ))}
      </MenuSub>
      <MenuSub icon="📚" label={L("ידע וספריות", "Knowledge and libraries")} {...subProps("knowledge")}>
        {list((x) => <MenuItem key={x.id} dir="auto" onSelect={() => p.onInsert(`${L("חפש בבסיס הידע", "Search the knowledge base")} "${x.name}": `)}>{x.name}</MenuItem>)}
        <MenuItem icon="📦" href="#/libraries">{L("חנות ספריות", "Library store")}</MenuItem>
      </MenuSub>
      <MenuSub icon="🧩" label={L("סקילים", "Skills")} {...subProps("skills")}>
        {list((x) => <MenuItem key={x.id ?? x.name} dir="auto" title={x.description} onSelect={() => p.onInsert(`${L("השתמש בסקיל", "Use the skill")} "${x.name}": `)}>{x.name}</MenuItem>)}
      </MenuSub>
      {p.onMode && (
        <MenuSub icon="✅" label={L("אישורים", "Approvals")} {...subProps("approvals")}>
          {modes.map(([m, label]) => <MenuItem key={m} kind="radio" checked={p.mode === m} onSelect={() => p.onMode!(m)}>{label}</MenuItem>)}
        </MenuSub>
      )}
      <MenuSeparator />
      <MenuItem icon="🔌" href="#/connections">{L("קונקטורים ומכשירים", "Connectors and devices")}</MenuItem>
      <MenuItem icon="🧠" href="#/memory">{L("זיכרונות", "Memory")}</MenuItem>
    </Menu>
  );
}

import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative } from "node:path";
import type { ImportedChat, ImportedMessage } from "./chat-import.js";

/**
 * Continue a Claude Code session in KesherAI (the CoolDown handoff): reads Claude Code's own session files on
 * this computer (`~/.claude/projects/<folder>/<session>.jsonl`, one JSON object per line; see
 * docs/RESEARCH_LOG.md) and turns one into a code chat in the same folder. The user's and Claude's words are
 * kept; each tool call becomes one short line, so the history fits a local model. Read only, this computer only.
 */

/** A session found on this computer. */
export interface ClaudeSession {
  file: string;
  sessionId: string;
  title: string;
  /** The project folder (`cwd`). */
  cwd?: string;
  updatedAt: string;
  size: number;
}

type Line = {
  type?: string;
  uuid?: string;
  parentUuid?: string | null;
  isSidechain?: boolean;
  cwd?: string;
  timestamp?: string;
  sessionId?: string;
  title?: string;
  aiTitle?: string;
  summary?: string;
  message?: { role?: string; content?: unknown };
};
type Block = { type?: string; text?: string; name?: string; input?: Record<string, unknown>; content?: unknown; is_error?: boolean };

/** Files larger than this are not read (a session that big would not fit a local model anyway). */
const MAX_BYTES = 60 * 1024 ** 2;

const parse = (text: string): Line[] =>
  text.split(/\r?\n/).flatMap((l) => {
    if (!l.trim()) return [];
    try {
      const o = JSON.parse(l) as unknown;
      return o && typeof o === "object" ? [o as Line] : [];
    } catch {
      return [];
    }
  });

const titleOf = (lines: Line[]): string | undefined => {
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i]!;
    const t = l.type === "ai-title" ? (l.aiTitle ?? l.title) : l.type === "summary" ? l.summary : undefined;
    if (typeof t === "string" && t.trim()) return t.trim();
  }
  return undefined;
};

/** One short line for a tool call: what Claude did, not its whole output. */
export function toolLine(name: string, input: Record<string, unknown> = {}): string {
  const s = (k: string) => (typeof input[k] === "string" ? (input[k] as string) : "");
  const short = (t: string, n = 160) => (t.length > n ? `${t.slice(0, n)}…` : t);
  if (/^(Edit|MultiEdit|Write|NotebookEdit)$/.test(name)) return `edited: ${s("file_path") || s("notebook_path")}`;
  if (name === "Read") return `read: ${s("file_path")}`;
  if (name === "Bash") return `ran: ${short(s("command").replace(/\s+/g, " "))}`;
  if (name === "Grep" || name === "Glob") return `searched: ${short(s("pattern"))}`;
  if (name === "Task") return s("description") || s("subagent_type") || s("prompt") ? `delegated: ${short(s("description") || s("subagent_type") || s("prompt"))}` : "delegated a subtask";
  if (name === "WebSearch") return `searched the web: ${short(s("query"))}`;
  if (name === "WebFetch") return `read the page: ${short(s("url"))}`;
  if (name === "TodoWrite" || name === "TaskCreate" || name === "TaskUpdate") return "updated the task list";
  return `used ${name}`;
}

/**
 * Turns a session file's lines into a chat: the newest branch (followed back from the last message by
 * `parentUuid`), without subagent work; tool calls as short lines.
 *
 * @param lines - The file's JSON lines.
 * @param file - The file (its name is the session id).
 * @returns The chat, with the folder it ran in.
 */
export function sessionToChat(lines: Line[], file: string): (ImportedChat & { workspace?: string }) | undefined {
  const byId = new Map<string, Line>();
  for (const l of lines) if (l.uuid) byId.set(l.uuid, l);
  const talk = lines.filter((l) => (l.type === "user" || l.type === "assistant") && !l.isSidechain && l.message);
  const last = talk.at(-1);
  if (!last) return undefined;
  // The newest branch: from the last message back to the start.
  const chain: Line[] = [];
  const seen = new Set<string>();
  for (let cur: Line | undefined = last; cur && !(cur.uuid && seen.has(cur.uuid)); cur = cur.parentUuid ? byId.get(cur.parentUuid) : undefined) {
    if (cur.uuid) seen.add(cur.uuid);
    chain.push(cur);
  }
  chain.reverse();
  const messages: ImportedMessage[] = [];
  const add = (role: "user" | "assistant", text: string, at?: string) => {
    const t = text.trim();
    if (!t) return;
    const prev = messages.at(-1);
    if (prev && prev.role === role) prev.text = `${prev.text}\n${t}`;
    else messages.push({ role, text: t, ...(at ? { at } : {}) });
  };
  for (const l of chain) {
    if ((l.type !== "user" && l.type !== "assistant") || l.isSidechain || !l.message) continue;
    const c = l.message.content;
    const role = l.type === "user" ? "user" : "assistant";
    if (typeof c === "string") {
      // Claude Code's own wrappers (a command it ran for the user, a reminder) are not the user's words.
      if (role === "user" && /^\s*<(command-|local-command|system-reminder)/.test(c)) continue;
      add(role, c, l.timestamp);
      continue;
    }
    if (!Array.isArray(c)) continue;
    for (const b of c as Block[]) {
      if (b.type === "text" && b.text) {
        if (role === "user" && /^\s*<(system-reminder|command-)/.test(b.text)) continue;
        add(role, b.text, l.timestamp);
      } else if (b.type === "tool_use" && b.name) add("assistant", `(${toolLine(b.name, b.input)})`, l.timestamp);
      else if (b.type === "tool_result" && b.is_error) add("assistant", "(that step failed)", l.timestamp);
      // Thinking, images and tool output are left out: they are long and the local model does not need them.
    }
  }
  if (!messages.length) return undefined;
  const sessionId = basename(file).replace(/\.jsonl$/i, "");
  const cwd = [...lines].reverse().find((l) => typeof l.cwd === "string")?.cwd;
  const first = messages.find((m) => m.role === "user")?.text ?? "Claude Code session";
  messages.push({ role: "user", text: "(This chat continues a Claude Code session. Tool steps are shown as short lines. Read the last steps, look at the project, and carry on where it stopped.)" });
  return {
    source: "claude-code",
    originalId: sessionId,
    title: titleOf(lines) ?? first.replace(/\s+/g, " ").slice(0, 80),
    createdAt: chain[0]?.timestamp ?? new Date().toISOString(),
    messages,
    ...(cwd ? { workspace: cwd } : {}),
  };
}

/**
 * Finds Claude Code sessions on this computer, newest first.
 *
 * @param home - The home folder.
 * @param limit - At most this many.
 */
export async function findClaudeSessions(home = homedir(), limit = 40): Promise<ClaudeSession[]> {
  const root = join(home, ".claude", "projects");
  const projects = await readdir(root).catch(() => [] as string[]);
  const files: Array<{ file: string; mtime: number; size: number }> = [];
  for (const p of projects) {
    const dir = join(root, p);
    for (const f of await readdir(dir).catch(() => [] as string[])) {
      if (!f.endsWith(".jsonl")) continue;
      const st = await stat(join(dir, f)).catch(() => undefined);
      if (st?.isFile()) files.push({ file: join(dir, f), mtime: st.mtimeMs, size: st.size });
    }
  }
  files.sort((a, b) => b.mtime - a.mtime);
  const out: ClaudeSession[] = [];
  for (const f of files.slice(0, limit)) {
    if (f.size > MAX_BYTES) continue;
    const lines = parse(await readFile(f.file, "utf8").catch(() => ""));
    const chat = sessionToChat(lines, f.file);
    if (!chat) continue;
    out.push({ file: f.file, sessionId: chat.originalId, title: chat.title, ...(chat.workspace ? { cwd: chat.workspace } : {}), updatedAt: new Date(f.mtime).toISOString(), size: f.size });
  }
  return out;
}

/**
 * Reads one session for import. Only files under `~/.claude/projects` are read.
 *
 * @param file - From {@link findClaudeSessions}.
 * @param home - The home folder.
 */
export async function readClaudeSession(file: string, home = homedir()): Promise<(ImportedChat & { workspace?: string }) | undefined> {
  const root = join(home, ".claude", "projects");
  const rel = relative(root, file);
  if (!rel || rel.startsWith("..") || isAbsolute(rel) || !file.endsWith(".jsonl")) throw new Error("That is not a Claude Code session on this computer.");
  const st = await stat(file).catch(() => undefined);
  if (!st?.isFile()) throw new Error("That session is gone.");
  if (st.size > MAX_BYTES) throw new Error("That session is too big to import.");
  return sessionToChat(parse(await readFile(file, "utf8")), file);
}

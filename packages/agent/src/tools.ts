import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { realpathSync } from "node:fs";
import { createTwoFilesPatch } from "diff";
import type { ToolRisk, ToolSpec } from "@kesher/shared";
import { IGNORED_DIRS, displayPath, globToRegExp, resolveForTool } from "./workspace.js";
import { buildExecutableTool } from "./build.js";
import { SYSTEM_TOOLS } from "./system-tools.js";
import { MAX_OUTPUT, runShell } from "./shell.js";
import { checkCodeTool, codeMapTool, findAssetsTool, findSymbolTool } from "./code-intel.js";
import { readDocumentTool } from "./documents.js";

/** What a tool returns. */
export interface ToolOutput {
  /** Text the model sees. Keep it short; long outputs are cut. */
  output: string;
  /** A unified diff, shown to the user for file changes. */
  diff?: string;
  /** Assets the tool produced, shown in the conversation. */
  assetIds?: string[];
  /** Video assets the tool produced, shown as players. */
  videoIds?: string[];
  /** Sound assets the tool produced (music, speech), shown as players. */
  audioIds?: string[];
  /** Files the tool made for the user (paths relative to the workspace), shown as cards with Download. */
  files?: string[];
  /** Pictures for the model to look at (vision models), e.g. a screenshot. Only the latest ones are kept in the conversation. */
  images?: Array<{ mimeType: string; data: string }>;
}

/** What a tool can use while running. */
export interface ToolContext {
  /** Absolute workspace folder; absent in plain chats. */
  workspace?: string;
  /** Folders or files the user gave access to in this conversation, outside the workspace. */
  extraRoots?: readonly string[];
  /** Aborted when the user presses Stop. */
  signal: AbortSignal;
  /**
   * Records a file's content before a change, so Undo can restore it.
   * Pass `null` for a file that did not exist.
   */
  recordChange(absolutePath: string, before: string | null): void;
  /** Shows live output of a long tool while it runs (builds, commands). Optional. */
  progress?(text: string): void;
}

/**
 * A tool the agent can call. Plugins and the core server add their own
 * (for example the media tools of the active models) next to the built-ins.
 */
export interface AgentTool {
  /** Name, description and JSON Schema, as sent to the model. */
  spec: ToolSpec;
  /** Decides when the tool needs approval; see `decide` in permissions.ts. */
  risk: ToolRisk;
  /** For `exec` tools: the command line, checked against the dangerous list. */
  commandOf?(input: Record<string, unknown>): string | undefined;
  /** What the user sees in an approval request: a diff, a command. */
  preview?(input: Record<string, unknown>, ctx: ToolContext): Promise<string>;
  /** Runs the tool. Throw an Error to report a failure to the model. */
  run(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutput>;
}

const MAX_READ_LINES = 2000;

/**
 * Shortens long tool output, keeping the start and the end, which is where
 * errors and summaries usually are.
 *
 * @param text - Output.
 * @param max - Character budget.
 * @returns The text, or its head and tail with a note in between.
 */
export function truncate(text: string, max = MAX_OUTPUT): string {
  if (text.length <= max) return text;
  const half = Math.floor(max / 2);
  return `${text.slice(0, half)}\n\n… [${text.length - max} characters cut] …\n\n${text.slice(-half)}`;
}

function str(input: Record<string, unknown>, key: string, required = true): string {
  const v = input[key];
  if (typeof v === "string") return v;
  if (v === undefined && !required) return "";
  throw new Error(`Missing or invalid "${key}" (expected a string).`);
}

function workspaceOf(ctx: ToolContext): string {
  if (!ctx.workspace) throw new Error("This conversation has no project folder. Start a code conversation to work with files.");
  return ctx.workspace;
}

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Builds a unified diff between two versions of a file.
 *
 * @param path - Display path.
 * @param before - Old content (`null` = new file).
 * @param after - New content.
 * @returns The diff text.
 */
export function makeDiff(path: string, before: string | null, after: string): string {
  return createTwoFilesPatch(before === null ? "/dev/null" : `a/${path}`, `b/${path}`, before ?? "", after, "", "", { context: 3 })
    .split("\n")
    .slice(1) // drop the "====" separator line createTwoFilesPatch adds
    .join("\n");
}

async function* walk(root: string, dir: string): AsyncGenerator<string> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const e of entries) {
    if (e.isDirectory()) {
      if (!IGNORED_DIRS.has(e.name)) yield* walk(root, join(dir, e.name));
    } else if (e.isFile()) {
      yield join(dir, e.name);
    }
  }
}

const listFiles: AgentTool = {
  risk: "read",
  spec: {
    name: "list_files",
    description:
      "List files in the project folder, recursively. Use a glob to narrow it (e.g. \"src/**/*.ts\"). Skips .git, node_modules and build folders.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Folder to list, relative to the project. Default: the project root." },
        glob: { type: "string", description: "Only files whose path (relative to the project) matches this glob." },
      },
    },
  },
  async run(input, ctx) {
    const root = workspaceOf(ctx);
    const dir = await resolveForTool(ctx.workspace, ctx.extraRoots ?? [], str(input, "path", false) || ".");
    const re = str(input, "glob", false) ? globToRegExp(str(input, "glob")) : undefined;
    const files: string[] = [];
    // A granted folder outside the project (request_access, a project added to a plain chat): its files are
    // matched relative to that folder and shown in full, so the glob works and read_file can take them
    // (found on the PC: relative to the project they all began with "..", nothing matched, "No files found").
    // Compared by real path: Windows may spell one folder two ways (a short name like RUNNER~1, found in CI).
    const real = (f: string) => { try { return realpathSync.native(f); } catch { return f; } };
    const rd = relative(real(root), real(dir));
    const inside = !rd.startsWith("..") && !isAbsolute(rd);
    for await (const f of walk(root, dir)) {
      const rel = inside ? displayPath(root, f) : relative(dir, f).split(sep).join("/");
      if (!re || re.test(rel)) files.push(inside ? rel : f);
      if (files.length >= 1000) break;
    }
    // A plain chat's own folder is often empty while its project was granted (+ → Tasks from the board): say
    // where to look instead of "No files found" (found on the PC: the model listed "." again and again).
    const grants = (ctx.extraRoots ?? []).filter((g) => g !== dir);
    if (files.length === 0 && inside && grants.length) return { output: `No files in your own folder. You can also use: ${grants.join(", ")}. Pass one of them as path (in full), and use full paths inside it with the other tools.` };
    if (files.length === 0) return { output: "No files found." };
    return { output: files.join("\n") + (files.length >= 1000 ? "\n… (stopped at 1000 files; use a glob to narrow)" : "") };
  },
};

const readFileTool: AgentTool = {
  risk: "read",
  spec: {
    name: "read_file",
    description: "Read a text file from the project. Returns numbered lines. For big files, read a range with offset and limit.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path, relative to the project." },
        offset: { type: "integer", description: "First line to read, starting at 1." },
        limit: { type: "integer", description: `How many lines (default ${MAX_READ_LINES}).` },
      },
      required: ["path"],
    },
  },
  async run(input, ctx) {
    const path = await resolveForTool(ctx.workspace, ctx.extraRoots ?? [], str(input, "path"));
    const info = await stat(path).catch(() => undefined);
    if (!info) throw new Error(`${str(input, "path")} does not exist.`);
    if (info.isDirectory()) throw new Error(`${str(input, "path")} is a folder. Use list_files.`);
    if (info.size > 5 * 1024 * 1024) throw new Error("File is larger than 5 MB; read it in parts with a command instead.");
    const text = await readFile(path, "utf8");
    if (text.includes("\u0000")) throw new Error("This looks like a binary file, not text.");
    const lines = text.split(/\r?\n/);
    const start = Math.max(1, Number(input.offset ?? 1));
    const count = Math.max(1, Number(input.limit ?? MAX_READ_LINES));
    const slice = lines.slice(start - 1, start - 1 + count);
    const body = slice.map((l, i) => `${String(start + i).padStart(5)}  ${l}`).join("\n");
    const more = start - 1 + count < lines.length ? `\n… ${lines.length - (start - 1 + count)} more lines (use offset)` : "";
    return { output: truncate(body + more) };
  },
};

const searchTool: AgentTool = {
  risk: "read",
  spec: {
    name: "search",
    description: "Search file contents in the project with a regular expression. Returns file:line: text for each match.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "JavaScript regular expression, case-insensitive." },
        glob: { type: "string", description: "Only search files matching this glob, e.g. \"**/*.cs\"." },
        path: { type: "string", description: "Folder to search (a granted folder in full). Default: the project root." },
      },
      required: ["pattern"],
    },
  },
  async run(input, ctx) {
    const root = workspaceOf(ctx);
    let re: RegExp;
    try {
      re = new RegExp(str(input, "pattern"), "i");
    } catch (err) {
      throw new Error(`Invalid regular expression: ${(err as Error).message}`);
    }
    const globRe = str(input, "glob", false) ? globToRegExp(str(input, "glob")) : undefined;
    // Like list_files: a granted folder is searched by its own paths (a plain chat with the board's project).
    const dir = await resolveForTool(ctx.workspace, ctx.extraRoots ?? [], str(input, "path", false) || ".");
    const real = (f: string) => { try { return realpathSync.native(f); } catch { return f; } };
    const rd = relative(real(root), real(dir));
    const inside = !rd.startsWith("..") && !isAbsolute(rd);
    const grants = (ctx.extraRoots ?? []).filter((g) => g !== dir);
    const hits: string[] = [];
    for await (const f of walk(root, dir)) {
      ctx.signal.throwIfAborted();
      const own = inside ? displayPath(root, f) : relative(dir, f).split(sep).join("/");
      const rel = inside ? own : f;
      if (globRe && !globRe.test(own)) continue;
      const info = await stat(f).catch(() => undefined);
      if (!info || info.size > 1024 * 1024) continue;
      const text = await readFile(f, "utf8").catch(() => "");
      if (text.includes("\u0000")) continue;
      text.split(/\r?\n/).forEach((line, i) => {
        if (hits.length < 300 && re.test(line)) hits.push(`${rel}:${i + 1}: ${line.trim().slice(0, 240)}`);
      });
      if (hits.length >= 300) break;
    }
    if (!hits.length && inside && grants.length) return { output: `No matches in your own folder. You can also search: ${grants.join(", ")} (pass it as path).` };
    return { output: hits.length ? hits.join("\n") : "No matches." };
  },
};

/**
 * Stops write_file from replacing a big existing file with much less (seen on the PC: a local model that could not
 * read a 2,000-line file whole "rewrote" it from the parts it had read).
 *
 * @param path - As the model gave it.
 * @param before - The file now (null when new).
 * @param content - What the model wants to write.
 */
export function guardRewrite(path: string, before: string | null, content: string): void {
  if (before === null) return;
  const was = before.split("\n").length;
  const now = content.split("\n").length;
  if (was > 300 && now < was * 0.8) {
    throw new Error(`write_file would replace ${path} (${was} lines) with ${now} lines, removing ${was - now}. Change the part you need with edit_file instead (read that part with read_file offset/limit first). If removing them is really intended, delete them with edit_file.`);
  }
}

const writeFileTool: AgentTool = {
  risk: "write",
  spec: {
    name: "write_file",
    description: "Create a file or replace its whole content. For small changes to an existing file, prefer edit_file.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path, relative to the project." },
        content: { type: "string", description: "The complete new content." },
      },
      required: ["path", "content"],
    },
  },
  async preview(input, ctx) {
    const root = workspaceOf(ctx);
    const path = await resolveForTool(ctx.workspace, ctx.extraRoots ?? [], str(input, "path"));
    const before = await readText(path);
    guardRewrite(str(input, "path"), before, str(input, "content"));
    return makeDiff(displayPath(root, path), before, str(input, "content"));
  },
  async run(input, ctx) {
    const root = workspaceOf(ctx);
    const path = await resolveForTool(ctx.workspace, ctx.extraRoots ?? [], str(input, "path"));
    const before = await readText(path);
    const content = str(input, "content");
    guardRewrite(str(input, "path"), before, content);
    await mkdir(dirname(path), { recursive: true });
    ctx.recordChange(path, before);
    await writeFile(path, content, "utf8");
    const rel = displayPath(root, path);
    return { output: `${before === null ? "Created" : "Wrote"} ${rel} (${content.split("\n").length} lines).`, diff: makeDiff(rel, before, content) };
  },
};

/** read_file's line prefix (`  123  `). */
const LINE_NO = /^\s*\d+ {2}/;

/**
 * Finds `oldText` in `before` line by line, ignoring each line's leading and trailing spaces (and read_file's line
 * numbers when every line has one), and replaces it with `newText` moved to the file's indentation.
 *
 * @param before - The file.
 * @param oldText - What the model asked to replace.
 * @param newText - Its replacement.
 * @param eol - The file's line ending.
 * @returns The new file, or undefined when there is no single match.
 */
export function looseEdit(before: string, oldText: string, newText: string, eol: string): string | undefined {
  let olds = oldText.split(/\r?\n/);
  let news = newText.split(/\r?\n/);
  const numbered = (ls: string[]) => ls.filter((l) => l.trim()).length > 0 && ls.filter((l) => l.trim()).every((l) => LINE_NO.test(l));
  if (numbered(olds)) {
    olds = olds.map((l) => l.replace(LINE_NO, ""));
    if (numbered(news)) news = news.map((l) => l.replace(LINE_NO, ""));
  }
  while (olds.length && !olds[0]!.trim()) olds.shift();
  while (olds.length && !olds[olds.length - 1]!.trim()) olds.pop();
  if (!olds.length) return undefined;
  const lines = before.split(/\r?\n/);
  const hits: number[] = [];
  for (let i = 0; i + olds.length <= lines.length && hits.length < 2; i++) {
    if (olds.every((o, j) => o.trim() === lines[i + j]!.trim())) hits.push(i);
  }
  if (hits.length !== 1) return undefined;
  const at = hits[0]!;
  const indent = (s: string) => s.match(/^\s*/)![0];
  const fileIndent = indent(lines[at]!);
  const modelIndent = indent(olds[0]!);
  const moved = news.map((l) => (!l.trim() ? l : l.startsWith(modelIndent) ? fileIndent + l.slice(modelIndent.length) : fileIndent + l.trimStart()));
  return [...lines.slice(0, at), ...moved, ...lines.slice(at + olds.length)].join(eol);
}

async function applyEdit(ctx: ToolContext, input: Record<string, unknown>) {
  const root = workspaceOf(ctx);
  const path = await resolveForTool(ctx.workspace, ctx.extraRoots ?? [], str(input, "path"));
  const before = await readText(path);
  if (before === null) throw new Error(`${str(input, "path")} does not exist. Use write_file to create it.`);
  const oldText = str(input, "old_text");
  const newText = str(input, "new_text");
  if (!oldText) throw new Error("old_text is empty.");
  // Files on Windows often use CRLF while models write LF: match either.
  const eol = before.includes("\r\n") ? "\r\n" : "\n";
  const needle = before.includes(oldText) ? oldText : oldText.replace(/\r?\n/g, eol);
  const replacement = needle === oldText ? newText : newText.replace(/\r?\n/g, eol);
  const count = before.split(needle).length - 1;
  if (count === 0) {
    // Local models often get the indentation or trailing spaces wrong, or copy read_file's line numbers (seen on the
    // PC: three failed tries, then the model rewrote a whole 2,000-line file). Like Aider, match line by line ignoring
    // that, when the match is unique, and keep the file's own indentation.
    const loose = looseEdit(before, oldText, newText, eol);
    if (loose) return { path, before, after: loose, rel: displayPath(root, path) };
    throw new Error("old_text was not found in the file. Read the file again and copy the exact text, including spaces.");
  }
  if (count > 1 && input.replace_all !== true) {
    throw new Error(`old_text appears ${count} times. Add more surrounding lines so it is unique, or set replace_all.`);
  }
  const after = input.replace_all === true ? before.split(needle).join(replacement) : before.replace(needle, () => replacement);
  return { path, before, after, rel: displayPath(root, path) };
}

const editFileTool: AgentTool = {
  risk: "write",
  spec: {
    name: "edit_file",
    description:
      "Replace exact text in a file. old_text must match the file exactly (copy it from read_file without the line numbers) and appear once, unless replace_all is true.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path, relative to the project." },
        old_text: { type: "string", description: "Exact text to replace." },
        new_text: { type: "string", description: "Replacement text." },
        replace_all: { type: "boolean", description: "Replace every occurrence." },
      },
      required: ["path", "old_text", "new_text"],
    },
  },
  async preview(input, ctx) {
    const e = await applyEdit(ctx, input);
    return makeDiff(e.rel, e.before, e.after);
  },
  async run(input, ctx) {
    const e = await applyEdit(ctx, input);
    ctx.recordChange(e.path, e.before);
    await writeFile(e.path, e.after, "utf8");
    return { output: `Edited ${e.rel}.`, diff: makeDiff(e.rel, e.before, e.after) };
  },
};

const runCommandTool: AgentTool = {
  risk: "exec",
  spec: {
    name: "run_command",
    description:
      "Run a shell command in the project folder (cmd on Windows, sh elsewhere) and return its output and exit code. Use it to build, test, run git status, install packages. Commands that never finish (servers, watchers) are stopped at the timeout.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "The command line." },
        purpose: { type: "string", description: "One short sentence for the user, in their language: what this command does and why it is needed now. Shown when they approve it." },
        timeout_seconds: { type: "integer", description: "Stop after this many seconds (default 120, max 600)." },
      },
      required: ["command"],
    },
  },
  commandOf: (input) => (typeof input.command === "string" ? input.command : undefined),
  async preview(input) {
    return str(input, "command");
  },
  async run(input, ctx) {
    const cwd = workspaceOf(ctx);
    const command = str(input, "command");
    const timeoutMs = Math.min(600, Math.max(1, Number(input.timeout_seconds ?? 120))) * 1000;
    const r = await runShell(command, cwd, timeoutMs, ctx.signal, ctx.progress);
    return { output: truncate(`${r.output.trim() || "(no output)"}\n\n${r.status}`) };
  },
};

/** Name of the special tool through which the agent asks the user a question. */
export const ASK_USER_TOOL = "ask_user";

/** Spec of the ask_user tool; the session handles it itself. */
export const askUserSpec: ToolSpec = {
  name: ASK_USER_TOOL,
  description:
    "Ask the user a question and wait for the answer. Use it when the request is ambiguous, when there are real choices to make (e.g. which library, which file), or before something large. Offer short options when you can.",
  inputSchema: {
    type: "object",
    properties: {
      question: { type: "string", description: "The question, one or two sentences." },
      options: { type: "array", items: { type: "string" }, description: "2–4 suggested answers. The user can still type their own." },
    },
    required: ["question"],
  },
};

/** Name of the special tool through which the agent shows its plan in plan mode. */
export const PRESENT_PLAN_TOOL = "present_plan";

/** Spec of present_plan; the session handles it itself (offered only in plan mode). */
export const presentPlanSpec: ToolSpec = {
  name: PRESENT_PLAN_TOOL,
  description:
    "Plan mode: show the user your plan and stop. Write it in Markdown, in the user's language: the goal in one line, then numbered steps naming the files you will change or create and how, the commands you will run, and how you will check that it works. Mention risks or choices the user should know about.",
  inputSchema: { type: "object", properties: { plan: { type: "string" } }, required: ["plan"] },
};

/** Name of the special tool through which the agent asks for a folder or file outside its own. */
export const REQUEST_ACCESS_TOOL = "request_access";

/** Spec of request_access; the session handles it itself. */
export const requestAccessSpec: ToolSpec = {
  name: REQUEST_ACCESS_TOOL,
  description:
    "Ask the user for access to a folder or file outside your project folder (for example their Documents, a game project, or a file they mentioned). The user approves, picks another place, or refuses. After approval, the file tools accept absolute paths inside it. Do not use it for the project folder itself.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "The absolute folder or file you need, if you know it. Leave empty to let the user choose." },
      reason: { type: "string", description: "One sentence: what you will do there." },
    },
    required: ["reason"],
  },
};

/** The file and terminal tools of a code conversation. */
/** Pictures the model can look at (formats the vision APIs take). */
const PICTURE_TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif" };

/**
 * Looks at a picture: one the user attached (a photo, or a screenshot they
 * marked up with arrows, circles and numbered notes) or one in the project.
 * The model sees the picture itself (models without vision get only its size).
 */
export const viewImageTool: AgentTool = {
  risk: "read",
  spec: {
    name: "view_image",
    description: "Look at a picture file (PNG, JPG, WebP, GIF): one the user attached (\"[Attached: …]\", e.g. a screenshot they marked up with arrows, boxes and numbered notes) or one in the project. Use it whenever the user attached a picture.",
    inputSchema: { type: "object", properties: { path: { type: "string", description: "The picture's path (as attached, or relative to the project)." } }, required: ["path"] },
  },
  async run(input, ctx) {
    const given = str(input, "path").replace(/^\[?\s*(Attached|מצורף)\s*:\s*/i, "").replace(/\]\s*$/, "").trim();
    const path = await resolveForTool(ctx.workspace, ctx.extraRoots ?? [], given);
    const type = PICTURE_TYPES[path.split(".").pop()?.toLowerCase() ?? ""];
    if (!type) throw new Error("Not a picture (PNG, JPG, WebP or GIF).");
    const info = await stat(path).catch(() => undefined);
    if (!info?.isFile()) throw new Error(`${given} does not exist.`);
    if (info.size > 8 * 1024 * 1024) throw new Error("The picture is larger than 8 MB.");
    const data = await readFile(path);
    return { output: `Looking at ${ctx.workspace ? displayPath(ctx.workspace, path) : path} (${Math.round(info.size / 1024)} KB).`, images: [{ mimeType: type, data: data.toString("base64") }] };
  },
};

export const CODE_TOOLS: readonly AgentTool[] = [listFiles, codeMapTool, findSymbolTool, findAssetsTool, readFileTool, viewImageTool, readDocumentTool, searchTool, writeFileTool, editFileTool, checkCodeTool, runCommandTool, buildExecutableTool, ...SYSTEM_TOOLS];

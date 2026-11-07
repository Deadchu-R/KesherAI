import { spawn } from "node:child_process";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createTwoFilesPatch } from "diff";
import type { ToolRisk, ToolSpec } from "@kesher/shared";
import { IGNORED_DIRS, displayPath, globToRegExp, resolveInWorkspace } from "./workspace.js";

/** What a tool returns. */
export interface ToolOutput {
  /** Text the model sees. Keep it short; long outputs are cut. */
  output: string;
  /** A unified diff, shown to the user for file changes. */
  diff?: string;
  /** Assets the tool produced, shown in the conversation. */
  assetIds?: string[];
}

/** What a tool can use while running. */
export interface ToolContext {
  /** Absolute workspace folder; absent in plain chats. */
  workspace?: string;
  /** Aborted when the user presses Stop. */
  signal: AbortSignal;
  /**
   * Records a file's content before a change, so Undo can restore it.
   * Pass `null` for a file that did not exist.
   */
  recordChange(absolutePath: string, before: string | null): void;
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

const MAX_OUTPUT = 30_000;
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
    const dir = await resolveInWorkspace(root, str(input, "path", false) || ".");
    const re = str(input, "glob", false) ? globToRegExp(str(input, "glob")) : undefined;
    const files: string[] = [];
    for await (const f of walk(root, dir)) {
      const rel = displayPath(root, f);
      if (!re || re.test(rel)) files.push(rel);
      if (files.length >= 1000) break;
    }
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
    const root = workspaceOf(ctx);
    const path = await resolveInWorkspace(root, str(input, "path"));
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
    const hits: string[] = [];
    for await (const f of walk(root, root)) {
      ctx.signal.throwIfAborted();
      const rel = displayPath(root, f);
      if (globRe && !globRe.test(rel)) continue;
      const info = await stat(f).catch(() => undefined);
      if (!info || info.size > 1024 * 1024) continue;
      const text = await readFile(f, "utf8").catch(() => "");
      if (text.includes("\u0000")) continue;
      text.split(/\r?\n/).forEach((line, i) => {
        if (hits.length < 300 && re.test(line)) hits.push(`${rel}:${i + 1}: ${line.trim().slice(0, 240)}`);
      });
      if (hits.length >= 300) break;
    }
    return { output: hits.length ? hits.join("\n") : "No matches." };
  },
};

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
    const path = await resolveInWorkspace(root, str(input, "path"));
    return makeDiff(displayPath(root, path), await readText(path), str(input, "content"));
  },
  async run(input, ctx) {
    const root = workspaceOf(ctx);
    const path = await resolveInWorkspace(root, str(input, "path"));
    const before = await readText(path);
    const content = str(input, "content");
    await mkdir(dirname(path), { recursive: true });
    ctx.recordChange(path, before);
    await writeFile(path, content, "utf8");
    const rel = displayPath(root, path);
    return { output: `${before === null ? "Created" : "Wrote"} ${rel} (${content.split("\n").length} lines).`, diff: makeDiff(rel, before, content) };
  },
};

async function applyEdit(root: string, input: Record<string, unknown>) {
  const path = await resolveInWorkspace(root, str(input, "path"));
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
  if (count === 0) throw new Error("old_text was not found in the file. Read the file again and copy the exact text, including spaces.");
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
    const e = await applyEdit(workspaceOf(ctx), input);
    return makeDiff(e.rel, e.before, e.after);
  },
  async run(input, ctx) {
    const e = await applyEdit(workspaceOf(ctx), input);
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
    return new Promise<ToolOutput>((resolvePromise) => {
      const child = spawn(command, { cwd, shell: true, windowsHide: true, env: { ...process.env, CI: "1", FORCE_COLOR: "0" } });
      let out = "";
      const onData = (b: Buffer) => {
        out += b.toString();
        if (out.length > MAX_OUTPUT * 4) out = out.slice(-MAX_OUTPUT * 2);
      };
      child.stdout?.on("data", onData);
      child.stderr?.on("data", onData);
      let timedOut = false;
      const kill = () => {
        if (process.platform === "win32" && child.pid) spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
        else child.kill("SIGKILL");
      };
      const timer = setTimeout(() => {
        timedOut = true;
        kill();
      }, timeoutMs);
      const onAbort = () => kill();
      ctx.signal.addEventListener("abort", onAbort, { once: true });
      const finish = (code: number | null, error?: Error) => {
        clearTimeout(timer);
        ctx.signal.removeEventListener("abort", onAbort);
        const status = error
          ? `Could not start: ${error.message}`
          : timedOut
            ? `Stopped after ${timeoutMs / 1000} s (timeout).`
            : `Exit code ${code ?? "unknown"}.`;
        resolvePromise({ output: truncate(`${out.trim() || "(no output)"}\n\n${status}`) });
      };
      child.on("error", (err) => finish(null, err));
      child.on("close", (code) => finish(code));
    });
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

/** The file and terminal tools of a code conversation. */
export const CODE_TOOLS: readonly AgentTool[] = [listFiles, readFileTool, searchTool, writeFileTool, editFileTool, runCommandTool];

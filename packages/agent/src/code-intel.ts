import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { extname, join } from "node:path";
import type { AgentTool, ToolContext } from "./tools.js";
import { IGNORED_DIRS, displayPath } from "./workspace.js";
import { runShell } from "./shell.js";

/**
 * Two tools that help agents work in real projects, especially with small
 * local models:
 *
 * - `code_map`: every source file with its classes, functions and methods,
 *   so the model finds the right file without reading the whole project.
 * - `check_code`: runs the project's own checker (TypeScript, .NET/Unity C#,
 *   C/C++ with compile_commands.json, Python, Rust, Go) and returns the
 *   errors with file and line, to fix right after an edit.
 */

/** Folders of game engines and build tools that are never source. */
const EXTRA_IGNORED = new Set(["Library", "Temp", "Logs", "obj", "Obj", "Build", "Builds", "UserSettings", "Binaries", "Intermediate", "DerivedDataCache", "Saved", "Packages", ".vs", "dist", "build", "out", "target", "__pycache__", "venv", ".venv"]);

const PATTERNS: Record<string, RegExp[]> = {
  cs: [/^\s*(?:public|private|protected|internal|static|sealed|abstract|partial|\s)*\s*(class|struct|interface|enum|record)\s+(\w+)/, /^\s*(?:public|private|protected|internal)\s+(?:static\s+|virtual\s+|override\s+|async\s+|abstract\s+)*[\w<>[\],\s]+?\s+(\w+)\s*\(/],
  ts: [/^\s*export\s+(?:default\s+)?(?:abstract\s+)?(class|interface|type|enum|function|const)\s+(\w+)/, /^\s*(?:async\s+)?function\s+(\w+)/, /^\s*(?:public|private|protected|static|async|\s)*(\w+)\s*\([^)]*\)\s*[:{]/],
  cpp: [/^\s*(class|struct|enum(?:\s+class)?|namespace)\s+(?:[A-Z_]+_API\s+)?(\w+)/, /^\s*(?:virtual\s+|static\s+|inline\s+|UFUNCTION\([^)]*\)\s*)*[\w:<>*&\s]+?\s+[*&]?(\w+::\w+|\w+)\s*\([^;]*\)\s*(?:const)?\s*(?:override)?\s*[{]?\s*$/],
  py: [/^\s*(class|def|async def)\s+(\w+)/],
  go: [/^\s*(func|type)\s+(?:\([^)]*\)\s*)?(\w+)/],
  rs: [/^\s*(?:pub\s+)?(fn|struct|enum|trait|impl|mod)\s+(\w+)/],
  java: [/^\s*(?:public|private|protected|static|final|abstract|\s)*\s*(class|interface|enum|record)\s+(\w+)/, /^\s*(?:public|private|protected)\s+(?:static\s+)?[\w<>[\],\s]+?\s+(\w+)\s*\(/],
  gd: [/^\s*(class_name|func|signal)\s+(\w+)/],
};
const LANG: Record<string, keyof typeof PATTERNS> = { ".cs": "cs", ".ts": "ts", ".tsx": "ts", ".js": "ts", ".jsx": "ts", ".mjs": "ts", ".c": "cpp", ".cc": "cpp", ".cpp": "cpp", ".h": "cpp", ".hpp": "cpp", ".py": "py", ".go": "go", ".rs": "rs", ".java": "java", ".kt": "java", ".gd": "gd" };
const NOT_NAMES = new Set(["if", "for", "while", "switch", "catch", "return", "new", "else", "using", "lock", "foreach", "sizeof", "typeof", "nameof", "base", "this", "super", "function"]);

/**
 * Finds the names a source file defines.
 *
 * @param text - The file.
 * @param ext - Its extension, e.g. `.cs`.
 * @returns Up to 40 lines like `class Player`, `Jump()`.
 */
export function symbolsOf(text: string, ext: string): string[] {
  const lang = LANG[ext.toLowerCase()];
  if (!lang) return [];
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.length > 300 || /^\s*(\/\/|#|\*|\/\*)/.test(line)) continue;
    for (const re of PATTERNS[lang]!) {
      const m = re.exec(line);
      if (!m) continue;
      const kind = m.length > 2 && m[2] ? m[1]! : "";
      const name = (m.length > 2 && m[2] ? m[2] : m[1])!;
      if (NOT_NAMES.has(name)) break;
      out.push(kind && !/^(def|func|fn|function)$/.test(kind) ? `${kind} ${name}` : `${name}()`);
      break;
    }
    if (out.length >= 40) break;
  }
  return [...new Set(out)];
}

async function* sources(root: string, dir: string, depth = 0): AsyncGenerator<string> {
  if (depth > 12) return;
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (!IGNORED_DIRS.has(e.name) && !EXTRA_IGNORED.has(e.name)) yield* sources(root, full, depth + 1);
    } else if (e.isFile() && LANG[extname(e.name).toLowerCase()]) yield full;
  }
}

/**
 * Builds the map of a project.
 *
 * @param root - The project folder.
 * @param under - Only this subfolder (relative), if given.
 * @param budget - Characters at most.
 * @returns The map.
 */
export async function codeMap(root: string, under = ".", budget = 24_000): Promise<string> {
  const lines: string[] = [];
  let size = 0;
  let files = 0;
  let skipped = 0;
  for await (const f of sources(root, join(root, under))) {
    files++;
    const st = await stat(f).catch(() => undefined);
    if (!st || st.size > 400_000) continue;
    const syms = symbolsOf(await readFile(f, "utf8").catch(() => ""), extname(f));
    const line = `${displayPath(root, f)}${syms.length ? `: ${syms.join(", ")}` : ""}`;
    if (size + line.length > budget) {
      skipped++;
      continue;
    }
    lines.push(line);
    size += line.length + 1;
  }
  if (!files) return "No source files found.";
  return lines.join("\n") + (skipped ? `\n… ${skipped} more files (pass a subfolder to see them)` : "");
}

/** Which checker fits a project, and its command. */
export function checkerFor(root: string, files: string[]): { name: string; command: string } | undefined {
  const has = (f: string) => files.includes(f);
  const any = (re: RegExp) => files.some((f) => re.test(f));
  if (has("tsconfig.json")) return { name: "TypeScript", command: "npx --no-install tsc --noEmit -p . --pretty false" };
  const sln = files.find((f) => /\.sln$/i.test(f));
  const csproj = files.find((f) => /\.csproj$/i.test(f));
  if (sln || csproj) return { name: ".NET / Unity C#", command: `dotnet build "${sln ?? csproj}" --nologo -clp:NoSummary -v q` };
  if (has("compile_commands.json") || existsSync(join(root, "build", "compile_commands.json"))) return { name: "C/C++ (clang)", command: "CLANGCHECK" };
  if (has("Cargo.toml")) return { name: "Rust", command: "cargo check --quiet --message-format short" };
  if (has("go.mod")) return { name: "Go", command: "go vet ./..." };
  if (has("pyproject.toml") || has("setup.py") || any(/\.py$/)) return { name: "Python", command: "python -m compileall -q ." };
  return undefined;
}

/**
 * Keeps the lines of checker output that are errors or warnings with a
 * place in the code.
 *
 * @param out - What the checker printed.
 * @returns The useful lines (at most 80) and how many errors there are.
 */
export function problemsFrom(out: string): { lines: string[]; errors: number } {
  const keep = out.split(/\r?\n/).filter((l) => /(error|warning)\b/i.test(l) && /[\w/\\.-]+\.(cs|ts|tsx|js|cpp|cc|c|h|hpp|rs|go|py)[(:]\d+/i.test(l));
  const unique = [...new Set(keep.map((l) => l.trim()))];
  return { lines: unique.slice(0, 80), errors: unique.filter((l) => /\berror\b/i.test(l)).length };
}

const str = (input: Record<string, unknown>, k: string) => (typeof input[k] === "string" ? (input[k] as string).trim() : "");
const rootOf = (ctx: ToolContext) => {
  if (!ctx.workspace) throw new Error("This conversation has no project folder.");
  return ctx.workspace;
};

/** `code_map`: files and what they define. */
export const codeMapTool: AgentTool = {
  risk: "read",
  spec: {
    name: "code_map",
    description: "Map of the project: every source file with the classes, functions and methods it defines. Call it first in a project you do not know, then read only the files you need. Optional `path`: a subfolder.",
    inputSchema: { type: "object", properties: { path: { type: "string" } } },
  },
  async run(input, ctx) {
    return { output: await codeMap(rootOf(ctx), str(input, "path") || ".") };
  },
};

/** `check_code`: the project's own error check. */
export const checkCodeTool: AgentTool = {
  risk: "exec",
  spec: {
    name: "check_code",
    description: "Check the project for errors with its own compiler or checker (TypeScript, .NET/Unity C#, C/C++, Rust, Go, Python). Call it after you change code, and fix what it reports. Returns the errors with file and line.",
    inputSchema: { type: "object", properties: { purpose: { type: "string", description: "One short sentence for the user, in their language." } } },
  },
  commandOf() {
    return undefined;
  },
  async preview(_input, ctx) {
    const root = rootOf(ctx);
    const c = checkerFor(root, await readdir(root).catch(() => []));
    return c ? `Check the project for errors (${c.name}): ${c.command === "CLANGCHECK" ? "clang -fsyntax-only on the changed files" : c.command}` : "No checker found for this project.";
  },
  async run(_input, ctx) {
    const root = rootOf(ctx);
    const top = await readdir(root).catch(() => [] as string[]);
    const c = checkerFor(root, top);
    if (!c) return { output: "No checker found for this project (no tsconfig.json, .sln/.csproj, compile_commands.json, Cargo.toml, go.mod or Python files)." };
    let command = c.command;
    if (command === "CLANGCHECK") {
      const changed = (ctx as ToolContext & { changedFiles?: string[] }).changedFiles?.filter((f) => /\.(c|cc|cpp)$/i.test(f)) ?? [];
      if (!changed.length) return { output: "C/C++: change a .cpp file first; then this checks it with clang -fsyntax-only." };
      command = changed.map((f) => `clang -fsyntax-only "${f}"`).join(" && ");
    }
    const r = await runShell(command, root, 600_000, ctx.signal);
    const { lines, errors } = problemsFrom(r.output);
    if (/not recognized|command not found|No such file/i.test(r.output) && !lines.length) return { output: `${c.name}: the checker is not installed on this computer (${command.split(" ")[0]}). ${r.output.trim().slice(0, 300)}` };
    if (!lines.length) return { output: r.code === 0 ? `${c.name}: no errors.` : `${c.name} (${r.status}):\n${r.output.trim().slice(-3000)}` };
    return { output: `${c.name}: ${errors} error(s).\n${lines.join("\n")}` };
  },
};

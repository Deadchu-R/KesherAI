import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { extname, join } from "node:path";
import type { AgentTool, ToolContext } from "./tools.js";
import { IGNORED_DIRS, displayPath } from "./workspace.js";
import { runShell } from "./shell.js";
import { checkUnrealFolder } from "./unreal-cpp-check.js";

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

/** One source file in the index. */
interface Indexed {
  path: string;
  symbols: string[];
  /** Line of each symbol's definition (same order as symbols). */
  lines: number[];
  /** Identifiers the file uses (for "who uses this"). */
  words: Set<string>;
}

/** Files read before, by path: reused while their size and time are the same. */
const cache = new Map<string, { size: number; mtime: number; item: Indexed }>();

/** Symbol lines with their line numbers. */
function symbolsWithLines(text: string, ext: string): { symbols: string[]; lines: number[] } {
  const lang = LANG[ext.toLowerCase()];
  const symbols: string[] = [];
  const lines: number[] = [];
  if (!lang) return { symbols, lines };
  const all = text.split(/\r?\n/);
  for (let i = 0; i < all.length && symbols.length < 40; i++) {
    const line = all[i]!;
    if (line.length > 300 || /^\s*(\/\/|#|\*|\/\*)/.test(line)) continue;
    for (const re of PATTERNS[lang]!) {
      const m = re.exec(line);
      if (!m) continue;
      const kind = m.length > 2 && m[2] ? m[1]! : "";
      const name = (m.length > 2 && m[2] ? m[2] : m[1])!;
      if (NOT_NAMES.has(name)) break;
      const sym = kind && !/^(def|func|fn|function)$/.test(kind) ? `${kind} ${name}` : `${name}()`;
      if (!symbols.includes(sym)) {
        symbols.push(sym);
        lines.push(i + 1);
      }
      break;
    }
  }
  return { symbols, lines };
}

/** The bare name of a symbol line: `class Player` → Player, `Jump()` → Jump, `A::B()` → B. */
const bare = (sym: string) => sym.replace(/\(\)$/, "").split(/\s+/).pop()!.split("::").pop()!;

/**
 * Reads the project's source files (up to 5,000), reusing files that did not change.
 *
 * @param root - The project folder.
 * @param under - A subfolder (relative), or ".".
 */
export async function indexProject(root: string, under = "."): Promise<Indexed[]> {
  const out: Indexed[] = [];
  for await (const f of sources(root, join(root, under))) {
    if (out.length >= 5000) break;
    const st = await stat(f).catch(() => undefined);
    if (!st || st.size > 400_000) continue;
    const hit = cache.get(f);
    if (hit && hit.size === st.size && hit.mtime === st.mtimeMs) {
      out.push(hit.item);
      continue;
    }
    const text = await readFile(f, "utf8").catch(() => "");
    const { symbols, lines } = symbolsWithLines(text, extname(f));
    const item: Indexed = { path: displayPath(root, f), symbols, lines, words: new Set(text.match(/[A-Za-z_]\w{3,}/g) ?? []) };
    cache.set(f, { size: st.size, mtime: st.mtimeMs, item });
    out.push(item);
  }
  if (cache.size > 20_000) cache.clear();
  return out;
}

/**
 * How many other files use each file's names (Aider's repo-map idea, without
 * a parser): files the rest of the project leans on come first.
 */
function ranks(files: Indexed[]): Map<string, number> {
  const owner = new Map<string, string>();
  for (const f of files) for (const s of f.symbols) owner.set(bare(s), f.path);
  const score = new Map<string, number>(files.map((f) => [f.path, 0]));
  for (const f of files) {
    for (const w of f.words) {
      const o = owner.get(w);
      if (o && o !== f.path) score.set(o, (score.get(o) ?? 0) + 1);
    }
  }
  return score;
}

/**
 * Builds the map of a project: each source file with what it defines, the
 * most used files first (or the ones that match the query), within a budget,
 * so a model finds the right file without reading the project.
 *
 * @param root - The project folder.
 * @param under - Only this subfolder (relative), if given.
 * @param budget - Characters at most (about 4 per token).
 * @param query - Words: files whose path or names match come first.
 * @returns The map.
 */
export async function codeMap(root: string, under = ".", budget = 8_000, query = ""): Promise<string> {
  const files = await indexProject(root, under);
  if (!files.length) return "No source files found.";
  const score = ranks(files);
  const words = query.toLowerCase().split(/[^\w]+/).filter((w) => w.length > 1);
  const match = (f: Indexed) => (words.length ? words.filter((w) => f.path.toLowerCase().includes(w) || f.symbols.some((s) => s.toLowerCase().includes(w))).length : 0);
  const order = [...files].sort((a, b) => match(b) - match(a) || (score.get(b.path) ?? 0) - (score.get(a.path) ?? 0) || a.path.localeCompare(b.path));
  const lines: string[] = [];
  let size = 0;
  let skipped = 0;
  for (const f of order) {
    const used = score.get(f.path) ?? 0;
    const line = `${f.path}${used ? ` [used by ${used}]` : ""}${f.symbols.length ? `: ${f.symbols.join(", ")}` : ""}`;
    if (size + line.length > budget) {
      skipped++;
      continue;
    }
    lines.push(line);
    size += line.length + 1;
  }
  return lines.join("\n") + (skipped ? `\n… ${skipped} more files (give a query or a subfolder to see them)` : "");
}

/**
 * Where a name is defined (file:line) and which files use it.
 *
 * @param root - The project folder.
 * @param name - A class, function or method name.
 */
export async function findSymbol(root: string, name: string): Promise<string> {
  const files = await indexProject(root);
  const want = name.replace(/\(\)$/, "").trim();
  if (!want) return "Give a name.";
  const defs: string[] = [];
  for (const f of files) f.symbols.forEach((s, i) => bare(s) === want && defs.push(`${f.path}:${f.lines[i]}  ${s}`));
  const users = files.filter((f) => f.words.has(want) && !defs.some((d) => d.startsWith(`${f.path}:`))).map((f) => f.path);
  if (!defs.length && !users.length) return `No "${want}" in the project's source files.`;
  return [defs.length ? `Defined in:\n${defs.join("\n")}` : `"${want}" is not defined in the project's sources (an engine or library name?).`, users.length ? `Used in ${users.length} file(s):\n${users.slice(0, 40).join("\n")}${users.length > 40 ? "\n…" : ""}` : "Not used in other files."].join("\n\n");
}

/** Game-engine assets worth knowing by name (Unity and Unreal). */
const ASSET_KINDS: Record<string, string> = { ".prefab": "prefab", ".unity": "scene", ".asset": "asset", ".mat": "material", ".shadergraph": "shader graph", ".shader": "shader", ".anim": "animation", ".controller": "animator", ".uxml": "UI", ".uss": "UI style", ".inputactions": "input", ".uasset": "asset", ".umap": "level", ".tscn": "scene", ".tres": "resource" };
/** Unreal asset name prefixes, to say what a .uasset is without opening it. */
const UE_PREFIX: Array<[RegExp, string]> = [[/^BP_/, "Blueprint"], [/^WBP_|^W_/, "widget"], [/^ABP_/, "anim Blueprint"], [/^MI_/, "material instance"], [/^M_/, "material"], [/^T_/, "texture"], [/^SM_/, "static mesh"], [/^SK_/, "skeletal mesh"], [/^NS_|^FX_/, "Niagara"], [/^A_|^AM_/, "animation"], [/^S_|^SC_|^SW_/, "sound"], [/^DT_/, "data table"], [/^E_/, "enum"], [/^F_|^ST_/, "struct"], [/^IA_|^IMC_/, "input"], [/^L_|^LV_/, "level"]];

/**
 * The project's assets by name and kind (Unity Assets/, Unreal Content/,
 * Godot), matching a query, so the model finds the right prefab, Blueprint or
 * material without listing folders.
 *
 * @param root - The project folder.
 * @param query - Words to match in the path (empty: a summary by kind).
 */
export async function findAssets(root: string, query = ""): Promise<string> {
  const found: Array<{ path: string; kind: string }> = [];
  const start = ["Assets", "Content"].map((d) => join(root, d)).filter((d) => existsSync(d));
  const stack = start.length ? start : [root];
  let seen = 0;
  while (stack.length && seen < 60_000) {
    const dir = stack.pop()!;
    for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      seen++;
      if (e.name.startsWith(".")) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (!IGNORED_DIRS.has(e.name) && !EXTRA_IGNORED.has(e.name) && e.name !== "__ExternalActors__" && e.name !== "__ExternalObjects__") stack.push(full);
        continue;
      }
      const ext = extname(e.name).toLowerCase();
      let kind = ASSET_KINDS[ext];
      if (!kind) continue;
      if (ext === ".uasset") kind = UE_PREFIX.find(([re]) => re.test(e.name))?.[1] ?? "asset";
      found.push({ path: displayPath(root, full), kind });
    }
  }
  if (!found.length) return "No Unity, Unreal or Godot assets found here.";
  const words = query.toLowerCase().split(/[^\w]+/).filter((w) => w.length > 1);
  if (!words.length) {
    const by = new Map<string, number>();
    for (const a of found) by.set(a.kind, (by.get(a.kind) ?? 0) + 1);
    return `${found.length} assets: ${[...by].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${n} ${k}`).join(", ")}. Give a query (a name or a kind, e.g. "player prefab", "BP_Door", "material") to list them.`;
  }
  const hits = found.filter((a) => words.every((w) => a.path.toLowerCase().includes(w) || a.kind.includes(w)));
  if (!hits.length) return `No asset matches "${query}" (of ${found.length}).`;
  return hits.slice(0, 80).map((a) => `${a.path}  (${a.kind})`).join("\n") + (hits.length > 80 ? `\n… ${hits.length - 80} more (narrow the query)` : "");
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

/** `code_map`: files and what they define, the most used first. */
export const codeMapTool: AgentTool = {
  risk: "read",
  spec: {
    name: "code_map",
    description: "Map of the project: source files with the classes, functions and methods they define, the files the rest of the project uses most first. Call it first in a project you do not know (with `query` for the task's words, e.g. 'health damage'), then read only the files you need. Much cheaper than list_files plus reading files. Optional `path`: a subfolder.",
    inputSchema: { type: "object", properties: { query: { type: "string", description: "Words of the task: matching files come first." }, path: { type: "string" } } },
  },
  async run(input, ctx) {
    return { output: await codeMap(rootOf(ctx), str(input, "path") || ".", 8_000, str(input, "query")) };
  },
};

/** `find_symbol`: where a name is defined and who uses it. */
export const findSymbolTool: AgentTool = {
  risk: "read",
  spec: {
    name: "find_symbol",
    description: "Where a class, function or method is defined (file:line) and which files use it, before changing it. Faster and cheaper than search.",
    inputSchema: { type: "object", properties: { name: { type: "string", description: "e.g. UHealthComponent, ApplyDamage, PlayerController" } }, required: ["name"] },
  },
  async run(input, ctx) {
    return { output: await findSymbol(rootOf(ctx), str(input, "name")) };
  },
};

/** `find_assets`: Unity/Unreal/Godot assets by name and kind. */
export const findAssetsTool: AgentTool = {
  risk: "read",
  spec: {
    name: "find_assets",
    description: "The game project's assets by name and kind (Unity prefabs, scenes, materials; Unreal Blueprints, materials, meshes, levels; Godot scenes). No query: a count by kind. With a query (e.g. 'player prefab', 'BP_Door', 'material'): the matching paths.",
    inputSchema: { type: "object", properties: { query: { type: "string" } } },
  },
  async run(input, ctx) {
    return { output: await findAssets(rootOf(ctx), str(input, "query")) };
  },
};

/** `check_code`: the project's own error check. */
export const checkCodeTool: AgentTool = {
  risk: "exec",
  spec: {
    name: "check_code",
    description: "Check the project for errors with its own compiler or checker (TypeScript, .NET/Unity C#, C/C++, Rust, Go, Python), and Unreal C++ against the engine's rules (generated.h names, includes, delegates, class prefixes; no engine build needed). Call it after you change code, and fix what it reports. Returns the errors with file and line.",
    inputSchema: { type: "object", properties: { purpose: { type: "string", description: "One short sentence for the user, in their language." } } },
  },
  commandOf() {
    return undefined;
  },
  async preview(_input, ctx) {
    const root = rootOf(ctx);
    const c = checkerFor(root, await readdir(root).catch(() => []));
    return c ? `Check the project for errors (${c.name}): ${c.command === "CLANGCHECK" ? "clang -fsyntax-only on the changed files" : c.command}, and Unreal C++ rules if it has Unreal code` : "Check the code for errors (Unreal C++ rules for .h/.cpp files; nothing is built or run).";
  },
  async run(_input, ctx) {
    const root = rootOf(ctx);
    const top = await readdir(root).catch(() => [] as string[]);
    const c = checkerFor(root, top);
    // Unreal C++: the fast rules first (generated.h names, includes, delegates, A/U prefixes), with or without a compiler here.
    const ue = await checkUnrealFolder(root).catch(() => undefined);
    const ueText = ue ? (ue.length ? `Unreal C++ rules: ${ue.length} problem(s) — fix every error:\n${ue.slice(0, 60).join("\n")}` : "Unreal C++ rules: no problems found.") : "";
    if (!c) {
      if (ueText) return { output: ueText };
      const code = top.filter((f) => /\.(h|hpp|c|cc|cpp|cs|ts|tsx|js|py|rs|go)$/i.test(f));
      return { output: code.length ? "No checker found for this project (no tsconfig.json, .sln/.csproj, compile_commands.json, Cargo.toml, go.mod or Python files)." : `Nothing to check: there are no code files in ${root} yet. Write the files first (write_file), then call check_code again.` };
    }
    if (ue?.length) return { output: `${ueText}\n(Fix these first; then check_code runs the compiler too.)` };
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

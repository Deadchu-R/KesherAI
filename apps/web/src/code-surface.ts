/**
 * Pure helpers of the code surface (CodePanel.tsx): which files it opens, the diff against the last version with
 * accept / reject per hunk, the outline of a file, and the "Ask about this" message. No React, so they run in
 * `node:test`.
 */

/** The chat files the code surface opens (its "Open in chat" chip). */
export const CODE_FILES = /\.(tsx?|jsx?|mjs|cjs|mts|py|cs|cpp|cc|cxx|c|h|hpp|inl|java|go|rs|rb|php|kt|swift|lua|gd|sh|ps1|bat|sql|css|scss|less|html?|json|ya?ml|toml|xml|shader|hlsl|glsl|verse)$/i;

/** The step results that write a file: "Created x (12 lines).", "Wrote x (3 lines).", "Edited x.". */
const WROTE = /^(?:Created|Wrote|Edited) (.+?)(?: \(\d+ lines\))?\.?$/m;

/**
 * The code file a `write_file` / `edit_file` step made, from its result.
 *
 * @param tool - The tool's name; `ok` and `output` its result.
 * @returns The path inside the chat's folder, or undefined (another tool, a failure, or not a code file).
 */
export function codeFileFromResult(tool: string, ok: boolean, output: string): string | undefined {
  if (!ok || (tool !== "write_file" && tool !== "edit_file")) return undefined;
  const p = WROTE.exec(output)?.[1]?.trim().replace(/\\/g, "/");
  return p && CODE_FILES.test(p) ? p : undefined;
}

/** One line of a hunk: kept (" "), added ("+") or removed ("-"). */
export interface DiffLine { t: " " | "+" | "-"; text: string }

/** One change of a file's unified diff. Line numbers are 1-based. */
export interface Hunk { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: DiffLine[] }

/**
 * The hunks of a unified diff (as the agent's `write_file` and `edit_file` results carry it).
 *
 * @param diff - The diff text.
 * @returns The hunks in order; none for an empty or unreadable diff.
 */
export function parseDiff(diff: string): Hunk[] {
  const hunks: Hunk[] = [];
  let cur: Hunk | undefined;
  for (const raw of diff.split("\n")) {
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(raw);
    if (m) {
      cur = { oldStart: Number(m[1]), oldLines: m[2] === undefined ? 1 : Number(m[2]), newStart: Number(m[3]), newLines: m[4] === undefined ? 1 : Number(m[4]), lines: [] };
      hunks.push(cur);
    } else if (cur && (raw[0] === "+" || raw[0] === "-" || raw[0] === " ")) {
      cur.lines.push({ t: raw[0], text: raw.slice(1) });
    }
  }
  return hunks;
}

/** Lines added and removed by hunks, for the card's "+12 −3". */
export function diffStats(hunks: readonly Hunk[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const h of hunks) for (const l of h.lines) {
    if (l.t === "+") added++;
    else if (l.t === "-") removed++;
  }
  return { added, removed };
}

/** The lines of a hunk as they are now (kept and added) or as they were (kept and removed). */
const side = (h: Hunk, now: boolean): string[] => h.lines.filter((l) => l.t === " " || l.t === (now ? "+" : "-")).map((l) => l.text);

/**
 * Puts one change back ("Reject"): the lines the hunk added are replaced by the lines it removed.
 *
 * @param text - The file's current text.
 * @param h - The hunk, with its place in the current text (`newStart`).
 * @returns The new text, or undefined when the hunk's lines are no longer in the file (it was edited since).
 */
export function rejectHunk(text: string, h: Hunk): string | undefined {
  const lines = text.split("\n");
  const now = side(h, true);
  const was = side(h, false);
  const at = (i: number) => i >= 0 && i + now.length <= lines.length && now.every((l, k) => lines[i + k] === l);
  let start = Math.max(0, h.newStart - 1);
  if (!at(start)) {
    // Moved by other edits: the nearest place that holds the same lines.
    let best = -1;
    for (let i = 0; i + now.length <= lines.length; i++) if (at(i) && (best < 0 || Math.abs(i - start) < Math.abs(best - start))) best = i;
    if (best < 0 || now.length === 0) return undefined;
    start = best;
  }
  lines.splice(start, now.length, ...was);
  return lines.join("\n");
}

/**
 * The hunks that are left after one is decided. Rejecting changes the line count, so the later hunks move.
 *
 * @param hunks - The pending hunks.
 * @param index - The hunk decided.
 * @param rejected - True when the change was put back (its lines moved the ones after it), false when accepted.
 */
export function afterDecision(hunks: readonly Hunk[], index: number, rejected: boolean): Hunk[] {
  const h = hunks[index];
  if (!h) return [...hunks];
  const delta = rejected ? side(h, false).length - side(h, true).length : 0;
  return hunks.filter((_, i) => i !== index).map((x) => (x.newStart > h.newStart ? { ...x, newStart: x.newStart + delta } : x));
}

/** One symbol of a file's outline. */
export interface OutlineSymbol { line: number; name: string; kind: string }

const OUTLINE: Record<string, Array<[string, RegExp]>> = {
  typescript: [
    ["class", /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([\w$]+)/],
    ["interface", /^\s*(?:export\s+)?interface\s+([\w$]+)/],
    ["type", /^\s*(?:export\s+)?type\s+([\w$]+)\s*[=<]/],
    ["enum", /^\s*(?:export\s+)?(?:const\s+)?enum\s+([\w$]+)/],
    ["function", /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([\w$]+)/],
    ["function", /^\s*(?:export\s+)?const\s+([\w$]+)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[\w$]+)\s*(?::[^=]+)?=>/],
  ],
  python: [
    ["class", /^\s*class\s+(\w+)/],
    ["function", /^\s*(?:async\s+)?def\s+(\w+)/],
  ],
  csharp: [
    ["class", /^\s*(?:(?:public|internal|private|protected|static|abstract|sealed|partial)\s+)*(?:class|struct|interface|enum|record)\s+(\w+)/],
    ["method", /^\s*(?:(?:public|internal|private|protected|static|virtual|override|abstract|async)\s+)+[\w<>[\],.?]+\s+(\w+)\s*\([^;]*$/],
  ],
  cpp: [
    ["class", /^\s*(?:class|struct|enum(?:\s+class)?|namespace)\s+(?:[A-Z_]+_API\s+)?(\w+)/],
    ["function", /^[ \t]*(?:[\w:<>,*&~]+[ \t]+)+\**&?([\w:~]+)\s*\([^;]*$/],
  ],
};
OUTLINE.javascript = OUTLINE.typescript!;

/** Lines that look like a function but are control flow. */
const NOT_A_NAME = new Set(["if", "for", "while", "switch", "catch", "return", "else", "using", "foreach", "lock", "sizeof", "new"]);

/**
 * The symbols of a file for the outline: classes, types and functions of TypeScript / JavaScript, Python, C# and
 * C++ (found by line patterns; a short list that is right most of the time, not a parser).
 *
 * @param text - The file.
 * @param language - Monaco's language id (`languageOf`).
 * @returns The symbols in file order; none for other languages.
 */
export function outlineOf(text: string, language: string): OutlineSymbol[] {
  const rules = OUTLINE[language];
  if (!rules) return [];
  const out: OutlineSymbol[] = [];
  text.split("\n").forEach((l, i) => {
    if (l.length > 300) return;
    for (const [kind, re] of rules) {
      const name = re.exec(l)?.[1];
      if (name && !NOT_A_NAME.has(name)) {
        out.push({ line: i + 1, name, kind });
        return;
      }
    }
  });
  return out;
}

/** Lines of a file that hold a text (case-insensitive), for "search in file". */
export function findInText(text: string, query: string, limit = 200): Array<{ line: number; text: string }> {
  const q = query.toLowerCase();
  if (q.length < 1) return [];
  const out: Array<{ line: number; text: string }> = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length && out.length < limit; i++) if (lines[i]!.toLowerCase().includes(q)) out.push({ line: i + 1, text: lines[i]!.trim().slice(0, 160) });
  return out;
}

/**
 * The chat message for "Ask about this": the selected lines with `path:from-to` and what the user asked. Long
 * selections are cut, so the message stays short. `change` asks to change only these lines through `edit_file`.
 *
 * @param p - The file's path, the selected text, its first and last line, the question, whether it is a change, and
 *   `he`: whether to write the frame in Hebrew.
 */
export function askMessage(p: { path: string; selection: string; from: number; to: number; instruction: string; change: boolean; he: boolean }): string {
  const sel = p.selection.replace(/\s+$/, "");
  const cut = sel.length > 3000 ? `${sel.slice(0, 3000)}\n…` : sel;
  const where = `${p.path}:${p.from === p.to ? p.from : `${p.from}-${p.to}`}`;
  const lang = /\.([\w+#-]+)$/.exec(p.path)?.[1] ?? "";
  const block = `\`\`\`${lang}\n${cut}\n\`\`\``;
  const ask = p.instruction.trim();
  if (!p.change) return p.he ? `בקובץ ${where}, על השורות האלה:\n${block}\n\n${ask}` : `In ${where}, about these lines:\n${block}\n\n${ask}`;
  return p.he
    ? `בקובץ ${where}, לשנות את השורות האלה:\n${block}\n\n${ask}\n(קרא את הקובץ קודם, ושנה רק את השורות האלה עם edit_file.)`
    : `In ${where}, change these lines:\n${block}\n\n${ask}\n(Read the file first and change only these lines with edit_file.)`;
}

/** The 1-based line of a text offset. */
export function lineAt(text: string, offset: number): number {
  let n = 1;
  for (let i = 0; i < offset && i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

/** A folder tree of file paths for the panel's file tree. */
export interface TreeNode { name: string; path: string; children?: TreeNode[] }

/**
 * Builds the tree from flat paths: folders first, then files, each sorted by name.
 *
 * @param paths - File paths with `/`.
 */
export function buildFileTree(paths: readonly string[]): TreeNode[] {
  const root: TreeNode = { name: "", path: "", children: [] };
  for (const p of paths) {
    const parts = p.split("/");
    let node = root;
    parts.forEach((name, i) => {
      const path = parts.slice(0, i + 1).join("/");
      let next = node.children!.find((c) => c.name === name);
      if (!next) {
        next = { name, path, ...(i < parts.length - 1 ? { children: [] } : {}) };
        node.children!.push(next);
      }
      node = next;
    });
  }
  const sort = (n: TreeNode): void => {
    n.children?.sort((a, b) => Number(!!b.children) - Number(!!a.children) || a.name.localeCompare(b.name));
    n.children?.forEach(sort);
  };
  sort(root);
  return root.children!;
}

/** The path a unified diff is about (its `+++ b/path` line), for matching a diff to its file. */
export function diffPath(diff: string): string | undefined {
  return /^\+\+\+ (?:b\/)?(.+)$/m.exec(diff)?.[1]?.trim();
}

/** A hunk's lines as left (before) and right (after) pairs for the side-by-side view; a run of removals and additions share rows. */
export function pairRows(h: Hunk): Array<{ l?: DiffLine; r?: DiffLine }> {
  const rows: Array<{ l?: DiffLine; r?: DiffLine }> = [];
  for (let i = 0; i < h.lines.length; ) {
    const line = h.lines[i]!;
    if (line.t === " ") {
      rows.push({ l: line, r: line });
      i++;
      continue;
    }
    const gone: DiffLine[] = [];
    const came: DiffLine[] = [];
    while (i < h.lines.length && h.lines[i]!.t !== " ") (h.lines[i]!.t === "-" ? gone : came).push(h.lines[i++]!);
    for (let k = 0; k < Math.max(gone.length, came.length); k++) rows.push({ ...(gone[k] ? { l: gone[k]! } : {}), ...(came[k] ? { r: came[k]! } : {}) });
  }
  return rows;
}

const WORDS_C = new Set("abstract as async await base bool break case catch char class const continue default delete do double else enum export extends false final finally float for foreach from function get goto if implements import in instanceof int interface internal is let long namespace new null override package private protected public readonly record ref return sealed set short static string struct super switch this throw true try typeof undefined unsigned using var virtual void volatile while yield".split(" "));
const WORDS_PY = new Set("and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return self True try while with yield".split(" "));
const TOKENS_C = /\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$)|"(?:\\.|[^"\\\n])*"?|'(?:\\.|[^'\\\n])*'?|`(?:\\.|[^`\\])*`?|\b\d[\w.]*|[A-Za-z_$][\w$]*/g;
const TOKENS_PY = /#[^\n]*|"""[\s\S]*?(?:"""|$)|'''[\s\S]*?(?:'''|$)|"(?:\\.|[^"\\\n])*"?|'(?:\\.|[^'\\\n])*'?|\b\d[\w.]*|[A-Za-z_][\w]*/g;
const HASH_LANGS = new Set(["python", "shell", "yaml", "ini", "ruby", "powershell"]);

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * Light syntax colours for reading (no editor library, so the panel's first paint stays small; Monaco loads only
 * on Edit): comments, strings, numbers, keywords and Types, as HTML escaped, one string per line. A token that
 * spans lines (a block comment) is closed and reopened on each line.
 *
 * @param text - The file.
 * @param language - Monaco's language id (`languageOf`).
 * @returns One HTML string per line of `text`.
 */
export function highlightLines(text: string, language: string): string[] {
  const py = HASH_LANGS.has(language);
  const re = new RegExp((py ? TOKENS_PY : TOKENS_C).source, "g");
  const words = py ? WORDS_PY : WORDS_C;
  let html = "";
  let last = 0;
  const span = (cls: string, s: string) => (cls ? s.split("\n").map((p) => (p ? `<span class="${cls}">${esc(p)}</span>` : "")).join("\n") : esc(s));
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const t = m[0];
    html += esc(text.slice(last, m.index));
    last = m.index + t.length;
    const c = t[0]!;
    const cls = c === "/" || c === "#" ? "tk-c" : c === '"' || c === "'" || c === "`" ? "tk-s" : /\d/.test(c) ? "tk-n" : words.has(t) ? "tk-k" : /^[A-Z][a-z]/.test(t) ? "tk-t" : "";
    html += span(cls, t);
  }
  html += esc(text.slice(last));
  return html.split("\n");
}

/**
 * C# ↔ nodes, for people who do not write code: a Unity script becomes a
 * graph (like Visual Scripting) that they can read and change, then it is
 * written back as C#. No model is involved, and the round trip keeps the code:
 * every statement remembers its original text, so methods nobody touched come
 * back byte for byte and only the edited statements are rewritten.
 *
 * Statements become nodes: a method is an event (Start, Update, OnTriggerEnter…
 * or a function), `if` a Branch, `for`/`foreach`/`while` a Loop, a call a Call
 * node with one input per argument, `x = y` a Set, `var x = y` a Variable,
 * `return` a Return. Anything else (switch, try, lambdas…) stays as a "Code"
 * node with its text, so nothing is lost.
 */

/** One statement of a method. */
export type CsStmt =
  | { id: string; kind: "if"; cond: string; then: CsStmt[]; else?: CsStmt[]; src: string; dirty?: boolean }
  | { id: string; kind: "loop"; head: string; body: CsStmt[]; src: string; dirty?: boolean }
  | { id: string; kind: "call"; target: string; name: string; args: string[]; src: string; dirty?: boolean }
  | { id: string; kind: "set"; target: string; op: string; value: string; src: string; dirty?: boolean }
  | { id: string; kind: "local"; type: string; name: string; value: string; src: string; dirty?: boolean }
  | { id: string; kind: "return"; value: string; src: string; dirty?: boolean }
  | { id: string; kind: "code"; src: string; dirty?: boolean };

/** A method: its header, where its body is in the file, and its statements. */
export interface CsMethod {
  id: string;
  name: string;
  /** The header as written, e.g. `void OnTriggerEnter(Collider other)`. */
  header: string;
  params: Array<{ type: string; name: string }>;
  /** Where the body's text starts and ends in the file (inside the braces). */
  start: number;
  end: number;
  /** The indentation of the body's statements. */
  indent: string;
  body: CsStmt[];
}

/** Who can use a variable from other scripts. */
export type CsAccess = "public" | "private" | "protected" | "internal";

/** A field of a class: one of the script's variables. */
export interface CsField {
  type: string;
  name: string;
  /** The starting value as C# (`5f`, `"Hi"`, `new Vector3(0, 1, 0)`), when it has one. */
  value?: string;
  /** Shown in Unity's Inspector: public (without [HideInInspector]) or [SerializeField]. */
  shown: boolean;
  /** The text of [Tooltip("…")], when it has one. */
  tooltip?: string;
  /** Written as `public`. */
  isPublic?: boolean;
  /** Who can use it from other scripts: public, private (C#'s default), protected or internal. */
  access: CsAccess;
  /** const / static / readonly / event, or several names in one line: shown, not edited here. */
  locked?: boolean;
  /** Where the declaration (its attributes … the `;`) is in the file. */
  start: number;
  end: number;
}

/** A class (or struct) of the script: its name, base class, fields and methods. */
export interface CsClass {
  name: string;
  base?: string;
  /** Fields (the script's variables, shown in the Inspector when public or [SerializeField]). */
  fields: CsField[];
  methods: CsMethod[];
  /** Where the class body is in the file (after `{`, at `}`), and the indentation of its members. */
  open?: number;
  close?: number;
  indent?: string;
}

/** Unity's own events (called by the engine), shown as red event nodes. */
export const UNITY_EVENTS = new Set(["Awake", "Start", "Update", "FixedUpdate", "LateUpdate", "OnEnable", "OnDisable", "OnDestroy", "OnTriggerEnter", "OnTriggerExit", "OnTriggerStay", "OnCollisionEnter", "OnCollisionExit", "OnCollisionStay", "OnTriggerEnter2D", "OnTriggerExit2D", "OnCollisionEnter2D", "OnCollisionExit2D", "OnMouseDown", "OnMouseUp", "OnBecameVisible", "OnBecameInvisible", "OnGUI", "OnValidate", "Reset", "OnApplicationQuit", "OnApplicationPause"]);

/** Index after the string, char or comment starting at i, or i when there is none. */
function skipLiteral(t: string, i: number): number {
  const c = t[i];
  if (c === "/" && t[i + 1] === "/") {
    const e = t.indexOf("\n", i);
    return e < 0 ? t.length : e;
  }
  if (c === "/" && t[i + 1] === "*") {
    const e = t.indexOf("*/", i + 2);
    return e < 0 ? t.length : e + 2;
  }
  // Verbatim and interpolated strings: @"..." $"..." $@"..." @$"...".
  let j = i;
  let verbatim = false;
  while (t[j] === "@" || t[j] === "$") {
    if (t[j] === "@") verbatim = true;
    j++;
  }
  if (t[j] === '"' && (j > i || c === '"')) {
    if (t.startsWith('"""', j)) {
      const e = t.indexOf('"""', j + 3);
      return e < 0 ? t.length : e + 3;
    }
    j++;
    while (j < t.length) {
      if (verbatim && t[j] === '"' && t[j + 1] === '"') j += 2;
      else if (!verbatim && t[j] === "\\") j += 2;
      else if (t[j] === '"') return j + 1;
      else j++;
    }
    return t.length;
  }
  if (c === "'") {
    j = i + 1;
    while (j < t.length && t[j] !== "'") j += t[j] === "\\" ? 2 : 1;
    return j + 1;
  }
  return i;
}

/** Index of the bracket that closes the one at i (any of ( [ {). */
export function matchBracket(t: string, i: number): number {
  const open = t[i]!;
  const close = open === "(" ? ")" : open === "[" ? "]" : "}";
  let depth = 0;
  let j = i;
  while (j < t.length) {
    const k = skipLiteral(t, j);
    if (k !== j) {
      j = k;
      continue;
    }
    if (t[j] === open) depth++;
    else if (t[j] === close && --depth === 0) return j;
    j++;
  }
  return t.length - 1;
}

/** Splits at top-level commas (not inside brackets, strings or generics' parentheses). */
export function splitArgs(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  let i = 0;
  while (i < s.length) {
    const k = skipLiteral(s, i);
    if (k !== i) {
      cur += s.slice(i, k);
      i = k;
      continue;
    }
    const c = s[i]!;
    if ("([{<".includes(c)) depth++;
    if (")]}>".includes(c)) depth--;
    if (c === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
    } else cur += c;
    i++;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

let nextId = 0;
/** Generate a new unique statement id. */
export function newId(): string { return `s${++nextId}`; }

/** Where the statement starting at i ends (exclusive), and whether it is a block statement. */
function statementEnd(t: string, i: number): number {
  let j = i;
  let depth = 0;
  while (j < t.length) {
    const k = skipLiteral(t, j);
    if (k !== j) {
      j = k;
      continue;
    }
    const c = t[j]!;
    if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth--;
    else if (c === "{") {
      // A lambda or initializer inside an expression: skip it whole.
      j = matchBracket(t, j) + 1;
      if (depth === 0 && /^\s*[;,)]/.test(t.slice(j)) === false && /^\s*(\}|$)/.test(t.slice(j))) return j;
      continue;
    } else if (c === ";" && depth === 0) return j + 1;
    j++;
  }
  return t.length;
}

/** Skips spaces (comments are kept as Code nodes, so they are not skipped here). */
const skipSpace = (t: string, i: number) => {
  while (i < t.length && /\s/.test(t[i]!)) i++;
  return i;
};

/** The body of an if/loop: a { block } or one statement; returns its statements and where it ends. */
function readBody(t: string, i: number): { body: CsStmt[]; end: number } {
  i = skipSpace(t, i);
  if (t[i] === "{") {
    const close = matchBracket(t, i);
    return { body: parseStatements(t.slice(i + 1, close)), end: close + 1 };
  }
  const one = readStatement(t, i);
  return { body: one ? [one.stmt] : [], end: one ? one.end : i };
}

/** Reads one statement at i (after spaces). */
function readStatement(t: string, i: number): { stmt: CsStmt; end: number } | undefined {
  i = skipSpace(t, i);
  if (i >= t.length) return undefined;
  // A comment line: kept as it is.
  if (t.startsWith("//", i) || t.startsWith("/*", i)) {
    const e = skipLiteral(t, i);
    return { stmt: { id: newId(), kind: "code", src: t.slice(i, e) }, end: e };
  }
  const word = /^[A-Za-z_]\w*/.exec(t.slice(i))?.[0] ?? "";
  if (word === "if") {
    const p = t.indexOf("(", i);
    const pc = matchBracket(t, p);
    const then = readBody(t, pc + 1);
    let end = then.end;
    let elseBody: CsStmt[] | undefined;
    const after = skipSpace(t, end);
    if (/^else\b/.test(t.slice(after))) {
      const eb = readBody(t, after + 4);
      elseBody = eb.body;
      end = eb.end;
    }
    return { stmt: { id: newId(), kind: "if", cond: t.slice(p + 1, pc).trim(), then: then.body, ...(elseBody ? { else: elseBody } : {}), src: t.slice(i, end) }, end };
  }
  if (word === "for" || word === "foreach" || word === "while") {
    const p = t.indexOf("(", i);
    const pc = matchBracket(t, p);
    const b = readBody(t, pc + 1);
    return { stmt: { id: newId(), kind: "loop", head: t.slice(i, pc + 1).replace(/\s+/g, " "), body: b.body, src: t.slice(i, b.end) }, end: b.end };
  }
  if (word === "switch" || word === "try" || word === "do" || word === "using" || word === "lock" || word === "unsafe" || word === "fixed" || word === "checked") {
    // Kept whole: the statement and its blocks (try's catch/finally, do's while).
    let j = i + word.length;
    for (;;) {
      j = skipSpace(t, j);
      if (t[j] === "(") j = matchBracket(t, j) + 1;
      j = skipSpace(t, j);
      if (t[j] === "{") j = matchBracket(t, j) + 1;
      else {
        j = statementEnd(t, j);
        break;
      }
      const next = skipSpace(t, j);
      const w = /^(catch|finally|while)\b/.exec(t.slice(next))?.[1];
      if (!w) break;
      j = next + w.length;
      if (w === "while") {
        j = statementEnd(t, j);
        break;
      }
    }
    return { stmt: { id: newId(), kind: "code", src: t.slice(i, j) }, end: j };
  }
  if (t[i] === "{") {
    const close = matchBracket(t, i);
    return { stmt: { id: newId(), kind: "code", src: t.slice(i, close + 1) }, end: close + 1 };
  }
  const end = statementEnd(t, i);
  const src = t.slice(i, end);
  return { stmt: classify(src), end };
}

/** What kind of simple statement this is. */
function classify(src: string): CsStmt {
  const s = src.trim().replace(/;$/, "").trim();
  const id = newId();
  let m = /^return\b\s*([\s\S]*)$/.exec(s);
  if (m) return { id, kind: "return", value: m[1]!.trim(), src };
  // A call: target.Name(args) or Name(args), nothing after the closing parenthesis.
  m = /^((?:[\w.]+(?:<[\w,\s.]+>)?\.)?)(\w+)(?:<[\w,\s.]+>)?\s*\(/.exec(s);
  if (m && !/^(new|await|yield|throw|var)\b/.test(s)) {
    const open = s.indexOf("(", m[0].length - 1);
    const close = matchBracket(s, open);
    if (close === s.length - 1) return { id, kind: "call", target: m[1]!.replace(/\.$/, ""), name: m[2]!, args: splitArgs(s.slice(open + 1, close)), src };
  }
  // A local variable: Type name = value (var, int, float, Vector3, List<int>…).
  m = /^((?:var|[A-Za-z_][\w.]*(?:<[\w,\s.<>]+>)?(?:\[\])?\??))\s+([A-Za-z_]\w*)\s*=\s*([\s\S]+)$/.exec(s);
  if (m && !/^(return|yield|await|throw|new)$/.test(m[1]!)) return { id, kind: "local", type: m[1]!, name: m[2]!, value: m[3]!.trim(), src };
  // An assignment: target = value (and += -= *= /=).
  m = /^([A-Za-z_][\w.[\]]*)\s*([+\-*/%]?=)(?!=)\s*([\s\S]+)$/.exec(s);
  if (m) return { id, kind: "set", target: m[1]!, op: m[2]!, value: m[3]!.trim(), src };
  m = /^([A-Za-z_][\w.[\]]*)\s*(\+\+|--)$/.exec(s);
  if (m) return { id, kind: "set", target: m[1]!, op: m[2] === "++" ? "+=" : "-=", value: "1", src };
  return { id, kind: "code", src };
}

/** Splits a block's text into statements. */
export function parseStatements(t: string): CsStmt[] {
  const out: CsStmt[] = [];
  let i = 0;
  for (;;) {
    const r = readStatement(t, i);
    if (!r || r.end <= i) break;
    out.push(r.stmt);
    i = r.end;
  }
  return out;
}

/** Where a member's declaration really starts: after blank space, comments and #directives. */
function declStart(t: string, from: number, to: number): number {
  let i = from;
  while (i < to) {
    if (/\s/.test(t[i]!)) i++;
    else if (t.startsWith("//", i) || t.startsWith("/*", i)) i = skipLiteral(t, i);
    else if (t[i] === "#") i = t.indexOf("\n", i) < 0 ? to : t.indexOf("\n", i);
    else break;
  }
  return i;
}

/** The indentation of the line that has index i. */
function lineIndent(t: string, i: number): string {
  const ls = t.lastIndexOf("\n", i - 1) + 1;
  return /^[ \t]*/.exec(t.slice(ls))![0];
}

/** Whether a type has a comma outside <…> (several names in one declaration: `int a, b`). */
function topComma(type: string): boolean {
  let d = 0;
  for (const c of type) {
    if (c === "<") d++;
    else if (c === ">") d--;
    else if (c === "," && d === 0) return true;
  }
  return false;
}

const CONTROL = /^(if|for|foreach|while|switch|catch|using|lock|return|new|else|get|set|add|remove|init)$/;

/**
 * Insert a new statement into a body array at the given index.
 * The statement is marked dirty and gets a fresh id.
 *
 * @param body - The method body or branch/loop body to insert into.
 * @param index - Position to insert at (0 = beginning, body.length = end).
 * @param stmt - Partial statement (id is optional and will be replaced).
 */
export function insertStep(body: CsStmt[], index: number, stmt: Omit<CsStmt, "id">): void {
  const step = { ...stmt, id: newId(), dirty: true } as CsStmt;
  body.splice(Math.max(0, Math.min(index, body.length)), 0, step);
}

/**
 * Reads a C# file: its classes, their fields and methods, and each method's
 * statements.
 *
 * @param text - The script.
 */
export function parseCSharp(text: string): CsClass[] {
  nextId = 0;
  const classes: CsClass[] = [];
  const re = /\b(?:class|struct)\s+([A-Za-z_]\w*)(?:\s*<[^>{]*>)?(?:\s*:\s*([^{]+?))?\s*(?:where[^{]*)?\{/g;
  let m: RegExpExecArray | null;
  const taken: Array<[number, number]> = [];
  while ((m = re.exec(text))) {
    // Skip the word "class" inside a string or comment, and classes nested in a method.
    if (taken.some(([a, b]) => m!.index > a && m!.index < b)) continue;
    const open = m.index + m[0].length - 1;
    const close = matchBracket(text, open);
    const cls: CsClass = { name: m[1]!, ...(m[2] ? { base: m[2].split(",")[0]!.trim() } : {}), fields: [], methods: [], open: open + 1, close };
    let i = open + 1;
    let last = i;
    while (i < close) {
      const k = skipLiteral(text, i);
      if (k !== i) {
        i = k;
        last = text[k - 1] === "\n" || text.startsWith("//", i) ? k : last;
        continue;
      }
      const c = text[i];
      if (c === ";") {
        const start = declStart(text, last, i);
        const decl = text.slice(start, i).replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, "").trim();
        const f = /^((?:\[[^\]]*\]\s*)*)((?:(?:public|private|protected|internal|static|readonly|const|new|volatile)\s+)*)([\w.<>,[\]?\s]+?)\s+([A-Za-z_]\w*)\s*(?:=\s*([\s\S]+))?$/.exec(decl);
        if (f && !/\(/.test(f[3]!) && !/^(using|return)$/.test(f[3]!.trim())) {
          const type = f[3]!.trim();
          const isPublic = /\bpublic\b/.test(f[2]!);
          const tip = /\bTooltip\s*\(\s*"((?:[^"\\]|\\.)*)"\s*\)/.exec(f[1]!);
          cls.fields.push({
            type, name: f[4]!, ...(f[5] ? { value: f[5].trim() } : {}),
            shown: (isPublic && !/HideInInspector/.test(f[1]!)) || /SerializeField/.test(f[1]!),
            ...(tip ? { tooltip: tip[1]!.replace(/\\(.)/g, "$1") } : {}),
            ...(isPublic ? { isPublic } : {}),
            access: isPublic ? "public" : /\bprotected\b/.test(f[2]!) ? "protected" : /\binternal\b/.test(f[2]!) ? "internal" : "private",
            ...(/\b(const|static|readonly)\b/.test(f[2]!) || /\b(event|delegate)\b/.test(type) || topComma(type) ? { locked: true } : {}),
            start, end: i + 1,
          });
          if (cls.indent === undefined) cls.indent = lineIndent(text, start);
        }
        last = i + 1;
      } else if (c === "{") {
        const end = matchBracket(text, i);
        const header = text.slice(last, i).replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, "").replace(/\s+/g, " ").trim();
        const h = /([A-Za-z_]\w*)\s*(?:<[^>]*>)?\s*\(([^()]*(?:\([^()]*\)[^()]*)*)\)\s*(?:where [^{]*)?$/.exec(header);
        if (h && !CONTROL.test(h[1]!) && !/=>|=\s*$/.test(header) && !/\b(class|struct|interface|enum)\b/.test(header)) {
          const bodyText = text.slice(i + 1, end);
          const indent = /\n([ \t]*)\S/.exec(bodyText)?.[1] ?? "        ";
          const params = splitArgs(h[2]!).filter(Boolean).map((p) => {
            const parts = p.replace(/=.*$/, "").trim().split(/\s+/);
            return { name: parts.pop()!, type: parts.filter((w) => !/^(ref|out|in|params|this)$/.test(w)).join(" ") };
          });
          cls.methods.push({ id: `m${cls.methods.length + 1}`, name: h[1]!, header: header.replace(/^\[[^\]]*\]\s*/g, ""), params, start: i + 1, end, indent, body: parseStatements(bodyText) });
        }
        taken.push([i, end]);
        i = end + 1;
        last = i;
        continue;
      }
      i++;
    }
    taken.push([open, close]);
    if (cls.indent === undefined) {
      const first = /\n([ \t]*)\S/.exec(text.slice(open + 1, close));
      cls.indent = first && first[1]!.length > lineIndent(text, m.index).length ? first[1]! : `${lineIndent(text, m.index)}    `;
    }
    classes.push(cls);
  }
  return classes;
}

/** Whether a statement or anything inside it was changed. */
const changed = (s: CsStmt): boolean => !!s.dirty || (s.kind === "if" && (s.then.some(changed) || !!s.else?.some(changed))) || (s.kind === "loop" && s.body.some(changed));

/** Re-indents a statement's original text to a new indentation (keeps its inner layout). */
function reindent(src: string, indent: string): string {
  const lines = src.split("\n");
  const rest = lines.slice(1).filter((l) => l.trim());
  const common = rest.length ? Math.min(...rest.map((l) => /^[ \t]*/.exec(l)![0].length)) : 0;
  // The closing brace sits at the statement's own indentation; without one, continuation lines are one step in.
  const base = rest.some((l) => l.trim().startsWith("}")) ? common : Math.max(0, common - 4);
  const inner = lines.slice(1).map((l) => (l.trim() ? indent + l.slice(Math.min(base, /^[ \t]*/.exec(l)![0].length)) : l));
  return [indent + lines[0]!.trim(), ...inner].join("\n");
}

/** Writes statements as C#, at an indentation. */
export function writeStatements(list: CsStmt[], indent: string, step = "    "): string {
  return list.map((s) => writeStatement(s, indent, step)).join("\n");
}

function block(list: CsStmt[], indent: string, step: string): string {
  return `{\n${writeStatements(list, indent + step, step)}${list.length ? "\n" : ""}${indent}}`;
}

function writeStatement(s: CsStmt, indent: string, step: string): string {
  if (!changed(s)) return reindent(s.src.trim(), indent);
  switch (s.kind) {
    case "if":
      return `${indent}if (${s.cond}) ${block(s.then, indent, step)}${s.else ? ` else ${s.else.length === 1 && s.else[0]!.kind === "if" ? writeStatement(s.else[0]!, indent, step).trimStart() : block(s.else, indent, step)}` : ""}`;
    case "loop":
      return `${indent}${s.head} ${block(s.body, indent, step)}`;
    case "call":
      return `${indent}${s.target ? `${s.target}.` : ""}${s.name}(${s.args.join(", ")});`;
    case "set":
      return `${indent}${s.target} ${s.op} ${s.value};`;
    case "local":
      return `${indent}${s.type} ${s.name} = ${s.value};`;
    case "return":
      return `${indent}return${s.value ? ` ${s.value}` : ""};`;
    default:
      return reindent(s.src.trim(), indent);
  }
}

/**
 * Writes the classes back into the file: only methods with a changed
 * statement are rewritten; the rest of the file stays as it was.
 *
 * @param text - The original script.
 * @param classes - The parsed (and edited) classes.
 */
export function writeCSharp(text: string, classes: CsClass[]): string {
  const methods = classes.flatMap((c) => c.methods).filter((m) => m.body.some(changed) || (m as CsMethod & { dirty?: boolean }).dirty).sort((a, b) => b.start - a.start);
  let out = text;
  for (const m of methods) {
    const closeIndent = m.indent.length >= 4 ? m.indent.slice(4) : "";
    out = `${out.slice(0, m.start)}\n${writeStatements(m.body, m.indent)}\n${closeIndent}${out.slice(m.end)}`;
  }
  return out;
}

/** A node of the graph view (the same shape as the Blueprint canvas uses). */
export interface CsNode {
  id: string;
  title: string;
  class: string;
  x: number;
  y: number;
  comment?: string;
  pins: Array<{ name: string; label?: string; dir: "in" | "out"; type: string; default?: string; links?: string[] }>;
  /** Where the node is in its method (stable across reads of the file), for its saved place. */
  key?: string;
  /** Not wired into the method: kept on the graph, not in the code (as an unconnected node in Unreal). */
  detached?: boolean;
}

/** A chain of steps placed on the graph but not wired into the method (it is not in the code). */
export interface CsDetached {
  x: number;
  y: number;
  stmts: CsStmt[];
}

/** Where the nodes of a script's graphs are (by key) and the chains not wired in, per method name. */
export interface CsLayout {
  positions?: Record<string, { x: number; y: number }>;
  detached?: Record<string, CsDetached[]>;
}

/** What a statement is, without its values (so editing an input keeps its place on the graph). */
function signature(s: CsStmt): string {
  switch (s.kind) {
    case "call":
      return `${s.target}.${s.name}/${s.args.length}`;
    case "set":
      return s.target;
    case "local":
      return s.name;
    case "loop":
      return s.head.replace(/\s+/g, "");
    case "code":
      return s.src.trim().slice(0, 40);
    default:
      return "";
  }
}

/**
 * A stable name for a statement, for its saved place: its method, its kind and what it is, and how many like it
 * came before (inserting other steps does not move it).
 */
export function stmtKey(method: string, s: CsStmt, seen: Map<string, number>, prefix = ""): string {
  const base = `${method}/${prefix}${s.kind}:${signature(s)}`;
  const n = seen.get(base) ?? 0;
  seen.set(base, n + 1);
  return `${base}#${n}`;
}

/**
 * One method as nodes: an event node, then each statement wired by its flow
 * pins (Branch: True/False; Loop: Body/Completed). Nodes go where they were put (`layout.positions`); new ones are
 * laid out left to right. Chains not wired in (`layout.detached`) are drawn where they were left, wired among
 * themselves only, as unconnected nodes are in Unreal.
 *
 * @param m - The method.
 * @param layout - Saved places and unwired chains (the script's graph file).
 */
export function methodToNodes(m: CsMethod, layout?: CsLayout): CsNode[] {
  const nodes: CsNode[] = [];
  const ev: CsNode = {
    id: m.id,
    title: UNITY_EVENTS.has(m.name) ? `Event ${m.name}` : m.name,
    class: UNITY_EVENTS.has(m.name) ? "K2Node_Event" : "K2Node_FunctionEntry",
    x: 0,
    y: 0,
    pins: [{ name: "then", dir: "out", type: "exec" }, ...m.params.map((p) => ({ name: p.name, dir: "out" as const, type: p.type.toLowerCase() }))],
    key: `${m.name}/entry`,
  };
  const at = (n: CsNode) => {
    const p = n.key ? layout?.positions?.[n.key] : undefined;
    if (p) {
      n.x = p.x;
      n.y = p.y;
    }
    return n;
  };
  nodes.push(at(ev));
  const link = (from: CsNode, pin: string, to: CsNode) => {
    const p = from.pins.find((x) => x.name === pin);
    if (p) (p.links ??= []).push(`${to.id}:execute`);
  };
  // Lays out a list; returns the next column.
  const seen = new Map<string, number>();
  const place = (list: CsStmt[], from: CsNode | undefined, pin: string, col: number, row: number, path: string, detached = false): number => {
    let prev = from;
    let prevPin = pin;
    list.forEach((s) => {
      const n = nodeOf(s, col, row);
      n.key = stmtKey(m.name, s, seen, path.startsWith("d") ? "d:" : "");
      if (detached) n.detached = true;
      nodes.push(detached ? n : at(n));
      if (prev) link(prev, prevPin, n);
      col++;
      if (s.kind === "if") {
        const endT = place(s.then, n, "True", col, row, path, detached);
        const endF = s.else ? place(s.else, n, "False", col, row + 2, path, detached) : col;
        col = Math.max(endT, endF);
        // After both branches, the flow goes on from the Branch's Completed pin.
        prev = n;
        prevPin = "Completed";
      } else if (s.kind === "loop") {
        col = place(s.body, n, "Loop Body", col, row + 1, path, detached);
        prev = n;
        prevPin = "Completed";
      } else {
        prev = n;
        prevPin = "then";
      }
    });
    return col;
  };
  place(m.body, ev, "then", 1, 0, "b");
  // Unwired chains: drawn where they were left; their own steps are wired among themselves.
  (layout?.detached?.[m.name] ?? []).forEach((d, k) => {
    const first = nodes.length;
    place(d.stmts, undefined, "then", 0, 0, `d${k}`);
    const made = nodes.slice(first);
    const x0 = made[0]?.x ?? 0;
    const y0 = made[0]?.y ?? 0;
    for (const n of made) {
      n.detached = true;
      const p = n.key ? layout?.positions?.[n.key] : undefined;
      n.x = p ? p.x : d.x + (n.x - x0);
      n.y = p ? p.y : d.y + (n.y - y0);
    }
  });
  return nodes;
}

/** One statement as a node. */
function nodeOf(s: CsStmt, col: number, row: number): CsNode {
  // Long methods wrap into lanes of 5 nodes, so the graph stays readable without zooming far out.
  const base = { id: s.id, x: (col % 5) * 300, y: Math.floor(col / 5) * 560 + row * 170 };
  const execIn = { name: "execute", dir: "in" as const, type: "exec" };
  const then = { name: "then", dir: "out" as const, type: "exec" };
  switch (s.kind) {
    case "if":
      return { ...base, title: "Branch", class: "K2Node_IfThenElse", pins: [execIn, { name: "Condition", dir: "in", type: "bool", default: s.cond }, { name: "True", dir: "out", type: "exec" }, { name: "False", dir: "out", type: "exec" }, { name: "Completed", dir: "out", type: "exec" }] };
    case "loop":
      return { ...base, title: s.head.startsWith("foreach") ? "For Each Loop" : s.head.startsWith("while") ? "While Loop" : "For Loop", class: "K2Node_MacroInstance", comment: s.head, pins: [execIn, { name: "Loop Body", dir: "out", type: "exec" }, { name: "Completed", dir: "out", type: "exec" }] };
    case "call":
      return { ...base, title: s.name, class: "K2Node_CallFunction", ...(s.target ? { comment: s.target } : {}), pins: [execIn, ...(s.target ? [{ name: "Target", dir: "in" as const, type: "object", default: s.target }] : []), ...s.args.map((a, i) => ({ name: `arg${i}`, label: `Arg ${i + 1}`, dir: "in" as const, type: "wildcard", default: a })), then] };
    case "set":
      return { ...base, title: `Set ${s.target}`, class: "K2Node_VariableSet", pins: [execIn, { name: "value", label: s.op === "=" ? "Value" : `${s.op} Value`, dir: "in", type: "wildcard", default: s.value }, then] };
    case "local":
      return { ...base, title: `${s.type} ${s.name}`, class: "K2Node_TemporaryVariable", pins: [execIn, { name: "value", label: "Value", dir: "in", type: s.type.toLowerCase(), default: s.value }, then] };
    case "return":
      return { ...base, title: "Return", class: "K2Node_FunctionResult", pins: [execIn, ...(s.value ? [{ name: "value", label: "Value", dir: "in" as const, type: "wildcard", default: s.value }] : [])] };
    default:
      return { ...base, title: s.src.trim().startsWith("//") ? "Comment" : "Code", class: "K2Node_Code", comment: s.src.trim().split("\n")[0]!.slice(0, 80), pins: [execIn, then] };
  }
}

/** Finds a statement by id anywhere in a method, with the list that holds it. */
export function findStmt(list: CsStmt[], id: string): { list: CsStmt[]; index: number; stmt: CsStmt } | undefined {
  for (let i = 0; i < list.length; i++) {
    const s = list[i]!;
    if (s.id === id) return { list, index: i, stmt: s };
    const inner = s.kind === "if" ? findStmt(s.then, id) ?? (s.else ? findStmt(s.else, id) : undefined) : s.kind === "loop" ? findStmt(s.body, id) : undefined;
    if (inner) return inner;
  }
  return undefined;
}

/** A field as the variables panel edits it. */
export interface FieldSpec {
  type: string;
  name: string;
  /** The starting value as C#; empty for none. */
  value?: string;
  shown: boolean;
  tooltip?: string;
  /** Who can use it from other scripts; a new variable shown in the Inspector is public, a hidden one private. */
  access?: CsAccess;
}

const IDENT = /^[A-Za-z_]\w*$/;
const RESERVED = new Set("abstract as base bool break byte case catch char checked class const continue decimal default delegate do double else enum event explicit extern false finally fixed float for foreach goto if implicit in int interface internal is lock long namespace new null object operator out override params private protected public readonly ref return sbyte sealed short sizeof stackalloc static string struct switch this throw true try typeof uint ulong unchecked unsafe ushort using virtual void volatile while".split(" "));

/** Why a variable name cannot be used, or undefined when it can. */
export function fieldNameProblem(cls: CsClass, name: string, except?: string): string | undefined {
  if (!IDENT.test(name)) return "A name has letters, digits and _ only, and does not start with a digit.";
  if (RESERVED.has(name)) return `"${name}" is a C# word.`;
  if (name !== except && (cls.fields.some((f) => f.name === name) || cls.methods.some((m) => m.name === name))) return `"${name}" is already used in ${cls.name}.`;
  if (name === cls.name) return "A variable cannot have the class's name.";
  return undefined;
}

/** Writes a field's declaration (attributes, access, type, name, value). */
function writeField(f: FieldSpec, was: CsAccess | undefined, keep: string, rename?: string): string {
  const access = f.access ?? was ?? (f.shown ? "public" : "private");
  const pub = access === "public";
  const attrs: string[] = keep ? [keep] : [];
  if (rename && f.shown) attrs.push(`[UnityEngine.Serialization.FormerlySerializedAs("${rename}")]`);
  if (f.tooltip?.trim()) attrs.push(`[Tooltip("${f.tooltip.trim().replace(/["\\]/g, "\\$&")}")]`);
  if (f.shown && !pub) attrs.push("[SerializeField]");
  if (!f.shown && pub) attrs.push("[HideInInspector]");
  return `${attrs.length ? `${attrs.join(" ")} ` : ""}${access} ${f.type.trim()} ${f.name}${f.value?.trim() ? ` = ${f.value.trim()}` : ""};`;
}

/** Attributes of a declaration that the panel does not manage (kept as they are). */
function otherAttrs(decl: string): string {
  const out: string[] = [];
  const re = /\[([^\]]*)\]/g;
  let m: RegExpExecArray | null;
  const head = /^((?:\[[^\]]*\]\s*)*)/.exec(decl)![1]!;
  while ((m = re.exec(head))) {
    const parts = splitArgs(m[1]!).filter((a) => !/^\s*(SerializeField|HideInInspector|Tooltip\s*\(|(UnityEngine\.Serialization\.)?FormerlySerializedAs\s*\()/.test(a));
    if (parts.length) out.push(`[${parts.map((p) => p.trim()).join(", ")}]`);
  }
  return out.join(" ");
}

/**
 * Adds a variable to a class, after its last field (or at the top of the class).
 *
 * @returns The new text of the file.
 */
export function addField(text: string, cls: CsClass, f: FieldSpec): string {
  const problem = fieldNameProblem(cls, f.name);
  if (problem) throw new Error(problem);
  if (!f.type.trim()) throw new Error("Choose a type.");
  const indent = cls.indent ?? "    ";
  const line = `${indent}${writeField(f, undefined, "")}`;
  const lastField = cls.fields[cls.fields.length - 1];
  if (lastField) {
    const eol = text.indexOf("\n", lastField.end);
    const at = eol < 0 ? text.length : eol;
    return `${text.slice(0, at)}\n${line}${text.slice(at)}`;
  }
  const at = cls.open ?? 0;
  const nl = text.indexOf("\n", at);
  const after = nl >= 0 && !text.slice(at, nl).trim() ? nl : at;
  return `${text.slice(0, after)}\n${line}\n${text.slice(after)}`;
}

/** Index ranges of strings and comments in a part of a file. */
function literalRanges(t: string, from: number, to: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let i = from; i < to; ) {
    const k = skipLiteral(t, i);
    if (k !== i) {
      out.push([i, k]);
      i = k;
    } else i++;
  }
  return out;
}

/** Where a name is used in a class (not in strings or comments, not as `other.name`). */
export function fieldUses(text: string, cls: CsClass, name: string): number[] {
  const from = cls.open ?? 0;
  const to = cls.close ?? text.length;
  const lit = literalRanges(text, from, to);
  const re = new RegExp(`(?<![\\w.@])(this\\.)?\\b${name}\\b`, "g");
  re.lastIndex = from;
  const hits: number[] = [];
  let m: RegExpExecArray | null;
  const own = cls.fields.find((f) => f.name === name);
  while ((m = re.exec(text)) && m.index < to) {
    const at = m.index + (m[1]?.length ?? 0);
    if (lit.some(([a, b]) => at >= a && at < b)) continue;
    if (own && at >= own.start && at < own.end) continue;
    hits.push(at);
  }
  return hits;
}

/**
 * Changes a variable: its type, name, starting value, Inspector visibility and
 * tooltip. A new name is changed everywhere in the class too, and a variable
 * shown in the Inspector keeps the value set there ([FormerlySerializedAs]).
 * Its other attributes (Header, Range…) stay.
 *
 * @returns The new text of the file.
 */
export function updateField(text: string, cls: CsClass, name: string, f: FieldSpec): string {
  const old = cls.fields.find((x) => x.name === name);
  if (!old) throw new Error(`No variable "${name}" in ${cls.name}.`);
  if (old.locked) throw new Error(`"${name}" is const, static or shares its line; change it in the code.`);
  const problem = fieldNameProblem(cls, f.name, name);
  if (problem) throw new Error(problem);
  const renamed = f.name !== name;
  const uses = renamed ? fieldUses(text, cls, name) : [];
  const decl = text.slice(old.start, old.end);
  const keep = otherAttrs(decl);
  // An earlier rename's attribute stays, so values from before it are kept too.
  const prior = /FormerlySerializedAs\s*\(\s*"(\w+)"/.exec(decl)?.[1];
  const next = writeField(f, old.access, keep, renamed && old.shown ? name : prior);
  // Rename uses from the end so earlier offsets stay right; the declaration is replaced in between.
  let out = text;
  const edits: Array<[number, number, string]> = [[old.start, old.end, next], ...uses.map((u): [number, number, string] => [u, u + name.length, f.name])];
  edits.sort((a, b) => b[0] - a[0]);
  for (const [a, b, s] of edits) out = `${out.slice(0, a)}${s}${out.slice(b)}`;
  return out;
}

/**
 * Removes a variable (its whole line when it is alone on it).
 *
 * @returns The new text of the file.
 */
export function removeField(text: string, cls: CsClass, name: string): string {
  const old = cls.fields.find((x) => x.name === name);
  if (!old) throw new Error(`No variable "${name}" in ${cls.name}.`);
  if (old.locked) throw new Error(`"${name}" shares its line or is const/static; remove it in the code.`);
  const ls = text.lastIndexOf("\n", old.start - 1);
  const le = text.indexOf("\n", old.end);
  const before = text.slice(ls + 1, old.start);
  const after = text.slice(old.end, le < 0 ? text.length : le);
  if (!before.trim() && !after.trim()) return `${text.slice(0, ls < 0 ? 0 : ls)}${text.slice(le < 0 ? text.length : le)}`;
  return `${text.slice(0, old.start)}${text.slice(old.end).replace(/^[ \t]*/, "")}`;
}

/** C# for a starting value typed as plain text, by type (`5` → `5f` for a float, text → "text"). */
export function csValue(type: string, raw: string): string {
  const v = raw.trim();
  if (!v) return "";
  const t = type.trim();
  if (t === "string") return /^".*"$/.test(v) ? v : `"${v.replace(/["\\]/g, "\\$&")}"`;
  if (t === "float") return /^-?\d+(\.\d+)?$/.test(v) ? `${v}f` : v;
  if (t === "bool") return /^(true|false)$/i.test(v) ? v.toLowerCase() : v;
  return v;
}

/** Plain text for a starting value (the reverse of csValue), for the panel's inputs. */
export function plainValue(type: string, value: string | undefined): string {
  const v = (value ?? "").trim();
  if (type === "string" && /^"(?:[^"\\]|\\.)*"$/.test(v)) return v.slice(1, -1).replace(/\\(.)/g, "$1");
  if (type === "float" && /^-?\d+(\.\d+)?f$/i.test(v)) return v.slice(0, -1);
  return v;
}

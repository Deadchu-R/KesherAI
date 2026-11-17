/**
 * KesherAI's own spreadsheets (design SheetEditor, RESEARCH_LOG "Canvas documents, part 2"): cells as text, a value
 * from a formula when it starts with "=". Formulas are parsed into a tree and computed by this file; nothing she or
 * the model writes ever runs as code.
 */

/** A sheet. */
export interface Sheet {
  id: string;
  title: string;
  /** Cells by address ("A1"), as she typed them. */
  cells: Record<string, string>;
  cols: number;
  rows: number;
  convId?: string;
  rev: number;
  updatedAt: string;
  versions?: Array<{ rev: number; at: string; title: string; cells: Record<string, string>; cols: number; rows: number }>;
}

export const MAX_COLS = 52;
export const MAX_ROWS = 2000;

/** "A" → 0, "AB" → 27. */
export function colIndex(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** 0 → "A", 27 → "AB". */
export function colName(i: number): string {
  let s = "";
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

/** "B3" → { c: 1, r: 2 }, or undefined. */
export function parseRef(ref: string): { c: number; r: number } | undefined {
  const m = /^\$?([A-Za-z]{1,2})\$?(\d{1,5})$/.exec(ref.trim());
  if (!m) return undefined;
  const c = colIndex(m[1]!);
  const r = Number(m[2]) - 1;
  return c >= 0 && c < MAX_COLS && r >= 0 && r < MAX_ROWS ? { c, r } : undefined;
}

/** (1, 2) → "B3". */
export const addr = (c: number, r: number) => `${colName(c)}${r + 1}`;

type Val = number | string | boolean;
type Node =
  | { k: "num"; v: number }
  | { k: "str"; v: string }
  | { k: "ref"; a: string }
  | { k: "range"; from: string; to: string }
  | { k: "neg"; x: Node }
  | { k: "bin"; op: string; a: Node; b: Node }
  | { k: "fn"; name: string; args: Node[] };

class FormulaError extends Error {}

/** Parses a formula (without its "="). Throws FormulaError on bad syntax. */
export function parseFormula(src: string): Node {
  const t = src.match(/\s*("(?:[^"]|"")*"|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|\$?[A-Za-z]{1,2}\$?\d{1,5}(?::\$?[A-Za-z]{1,2}\$?\d{1,5})?|[A-Za-z][A-Za-z0-9.]*|<=|>=|<>|[-+*/^(),:<>=&%])/gy);
  const joined = (t ?? []).join("");
  if (joined.replace(/\s/g, "") !== src.replace(/\s/g, "")) throw new FormulaError("bad character");
  const toks = (t ?? []).map((x) => x.trim()).filter(Boolean);
  let i = 0;
  const peek = () => toks[i];
  const eat = (s?: string) => {
    const x = toks[i];
    if (s !== undefined && x !== s) throw new FormulaError(`expected ${s}`);
    i++;
    return x!;
  };
  const cmp = (): Node => {
    let a = concat();
    while (["=", "<>", "<", ">", "<=", ">="].includes(peek() ?? "")) a = { k: "bin", op: eat(), a, b: concat() };
    return a;
  };
  const concat = (): Node => {
    let a = add();
    while (peek() === "&") { eat(); a = { k: "bin", op: "&", a, b: add() }; }
    return a;
  };
  const add = (): Node => {
    let a = mul();
    while (peek() === "+" || peek() === "-") a = { k: "bin", op: eat(), a, b: mul() };
    return a;
  };
  const mul = (): Node => {
    let a = pow();
    while (peek() === "*" || peek() === "/") a = { k: "bin", op: eat(), a, b: pow() };
    return a;
  };
  const pow = (): Node => {
    const a = unary();
    if (peek() === "^") { eat(); return { k: "bin", op: "^", a, b: pow() }; }
    return a;
  };
  const unary = (): Node => {
    if (peek() === "-") { eat(); return { k: "neg", x: unary() }; }
    if (peek() === "+") { eat(); return unary(); }
    const a = atom();
    if (peek() === "%") { eat(); return { k: "bin", op: "/", a, b: { k: "num", v: 100 } }; }
    return a;
  };
  const atom = (): Node => {
    const x = peek();
    if (x === undefined) throw new FormulaError("unexpected end");
    if (x === "(") { eat(); const e = cmp(); eat(")"); return e; }
    if (/^\d/.test(x)) { eat(); return { k: "num", v: Number(x) }; }
    if (x.startsWith('"')) { eat(); return { k: "str", v: x.slice(1, -1).replace(/""/g, '"') }; }
    if (/^\$?[A-Za-z]{1,2}\$?\d/.test(x) && !/^[A-Za-z]+\(/.test(x)) {
      eat();
      const [from, to] = x.replace(/\$/g, "").toUpperCase().split(":");
      if (!parseRef(from!) || (to && !parseRef(to))) throw new FormulaError("bad reference");
      return to ? { k: "range", from: from!, to } : { k: "ref", a: from! };
    }
    if (/^[A-Za-z]/.test(x)) {
      const name = eat().toUpperCase();
      if (name === "TRUE" || name === "FALSE") return { k: "num", v: name === "TRUE" ? 1 : 0 };
      eat("(");
      const args: Node[] = [];
      if (peek() !== ")") {
        args.push(cmp());
        while (peek() === ",") { eat(); args.push(cmp()); }
      }
      eat(")");
      if (!FUNCS[name]) throw new FormulaError(`unknown function ${name}`);
      return { k: "fn", name, args };
    }
    throw new FormulaError(`unexpected ${x}`);
  };
  const e = cmp();
  if (i !== toks.length) throw new FormulaError("extra text");
  return e;
}

const nums = (vs: Val[]) => vs.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
const FUNCS: Record<string, (args: Val[][], raw: Val[]) => Val> = {
  SUM: (a) => nums(a.flat()).reduce((s, x) => s + x, 0),
  AVERAGE: (a) => { const n = nums(a.flat()); if (!n.length) throw new FormulaError("#DIV/0"); return n.reduce((s, x) => s + x, 0) / n.length; },
  MIN: (a) => (nums(a.flat()).length ? Math.min(...nums(a.flat())) : 0),
  MAX: (a) => (nums(a.flat()).length ? Math.max(...nums(a.flat())) : 0),
  COUNT: (a) => nums(a.flat()).length,
  COUNTA: (a) => a.flat().filter((v) => v !== "").length,
  ROUND: (_a, r) => { const d = Math.round(num(r[1] ?? 0)); const f = 10 ** d; return Math.round(num(r[0]) * f) / f; },
  ABS: (_a, r) => Math.abs(num(r[0])),
  SQRT: (_a, r) => { const x = num(r[0]); if (x < 0) throw new FormulaError("#NUM"); return Math.sqrt(x); },
  IF: (_a, r) => (truthy(r[0]) ? (r[1] ?? true) : (r[2] ?? false)),
  AND: (a) => a.flat().every(truthy),
  OR: (a) => a.flat().some(truthy),
  NOT: (_a, r) => !truthy(r[0]),
  LEN: (_a, r) => String(r[0] ?? "").length,
  UPPER: (_a, r) => String(r[0] ?? "").toUpperCase(),
  LOWER: (_a, r) => String(r[0] ?? "").toLowerCase(),
  CONCAT: (a) => a.flat().map(String).join(""),
};
const truthy = (v: Val | undefined) => (typeof v === "number" ? v !== 0 : typeof v === "boolean" ? v : !!v);
function num(v: Val | undefined): number {
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (v === "" || v === undefined) return 0;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new FormulaError("#VALUE");
  return n;
}

/** A cell's typed text as a value: a number when it reads as one, else text. */
const literal = (s: string): Val => (s.trim() !== "" && Number.isFinite(Number(s)) ? Number(s) : s);

/**
 * Every cell's value: numbers, text, or an error ("#ERR" bad formula, "#CYCLE", "#DIV/0", "#VALUE", "#REF").
 *
 * @param cells - The cells as typed.
 */
export function computeSheet(cells: Record<string, string>): Record<string, Val> {
  const out: Record<string, Val> = {};
  const busy = new Set<string>();
  const parsed = new Map<string, Node | Error>();
  const get = (a: string): Val => {
    if (a in out) return out[a]!;
    const raw = cells[a] ?? "";
    if (!raw.startsWith("=")) return (out[a] = literal(raw));
    if (busy.has(a)) throw new FormulaError("#CYCLE");
    busy.add(a);
    try {
      let n = parsed.get(a);
      if (!n) {
        try {
          n = parseFormula(raw.slice(1));
        } catch (e) {
          n = e as Error;
        }
        parsed.set(a, n);
      }
      if (n instanceof Error) return (out[a] = "#ERR");
      const v = evalNode(n);
      return (out[a] = typeof v === "number" && !Number.isFinite(v) ? "#DIV/0" : v);
    } catch (e) {
      const m = (e as Error).message;
      if (m === "#CYCLE") {
        busy.delete(a);
        throw e;
      }
      return (out[a] = /^#/.test(m) ? m : "#ERR");
    } finally {
      busy.delete(a);
    }
  };
  const range = (from: string, to: string): Val[] => {
    const a = parseRef(from)!;
    const b = parseRef(to)!;
    const vs: Val[] = [];
    for (let r = Math.min(a.r, b.r); r <= Math.max(a.r, b.r); r++) for (let c = Math.min(a.c, b.c); c <= Math.max(a.c, b.c); c++) vs.push(val(addr(c, r)));
    return vs;
  };
  const val = (a: string): Val => {
    const v = get(a);
    if (typeof v === "string" && /^#(CYCLE|ERR|DIV\/0|VALUE|REF|NUM)$/.test(v)) throw new FormulaError(v);
    return v;
  };
  const evalNode = (n: Node): Val => {
    switch (n.k) {
      case "num":
      case "str":
        return n.v;
      case "ref":
        return val(n.a);
      case "range":
        throw new FormulaError("#VALUE");
      case "neg":
        return -num(evalNode(n.x));
      case "fn": {
        const lists = n.args.map((x) => (x.k === "range" ? range(x.from, x.to) : [evalNode(x)]));
        return FUNCS[n.name]!(lists, lists.map((l) => l[0]!));
      }
      case "bin": {
        const a = evalNode(n.a);
        const b = evalNode(n.b);
        switch (n.op) {
          case "+": return num(a) + num(b);
          case "-": return num(a) - num(b);
          case "*": return num(a) * num(b);
          case "/": if (num(b) === 0) throw new FormulaError("#DIV/0"); return num(a) / num(b);
          case "^": return num(a) ** num(b);
          case "&": return `${a}${b}`;
          case "=": return a === b || (typeof a !== "string" && typeof b !== "string" && num(a) === num(b));
          case "<>": return !(a === b);
          case "<": return num(a) < num(b);
          case ">": return num(a) > num(b);
          case "<=": return num(a) <= num(b);
          case ">=": return num(a) >= num(b);
        }
      }
    }
    throw new FormulaError("#ERR");
  };
  for (const a of Object.keys(cells)) {
    if (!parseRef(a)) continue;
    try {
      get(a);
    } catch {
      out[a] = "#CYCLE";
    }
  }
  return out;
}

/** A value as she sees it: numbers rounded to 10 places, true/false as TRUE/FALSE. */
export function showValue(v: Val | undefined): string {
  if (v === undefined) return "";
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (typeof v === "number") return String(Math.round(v * 1e10) / 1e10);
  return v;
}

/** Cells from the page or the model, checked: real addresses inside the grid, text at most 2000 characters. */
export function cleanCells(raw: unknown, max = 50_000): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>).slice(0, max)) {
    const ref = parseRef(k);
    if (!ref || (typeof v !== "string" && typeof v !== "number") || v === "") continue;
    out[addr(ref.c, ref.r)] = String(v).replace(/\r/g, "").slice(0, 2000);
  }
  return out;
}

/** The sheet as CSV (values, as she sees them). */
export function sheetCsv(s: Pick<Sheet, "cells" | "cols" | "rows">): string {
  const vals = computeSheet(s.cells);
  let lastR = -1;
  let lastC = -1;
  for (const a of Object.keys(s.cells)) {
    const p = parseRef(a);
    if (p) { lastR = Math.max(lastR, p.r); lastC = Math.max(lastC, p.c); }
  }
  const q = (x: string) => (/[",\n]/.test(x) ? `"${x.replace(/"/g, '""')}"` : x);
  const lines: string[] = [];
  for (let r = 0; r <= lastR; r++) lines.push(Array.from({ length: lastC + 1 }, (_, c) => q(showValue(vals[addr(c, r)]))).join(","));
  return lines.join("\n");
}

/** CSV into cells (from A1), as typed text. */
export function csvCells(csv: string): Record<string, string> {
  const cells: Record<string, string> = {};
  let r = 0;
  let c = 0;
  let cur = "";
  let quoted = false;
  const put = () => {
    if (cur !== "" && c < MAX_COLS && r < MAX_ROWS) cells[addr(c, r)] = cur.slice(0, 2000);
    cur = "";
  };
  const s = csv.replace(/\r\n?/g, "\n");
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (quoted) {
      if (ch === '"' && s[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') quoted = false; else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { put(); c++; } else if (ch === "\n") { put(); r++; c = 0; } else cur += ch;
  }
  put();
  return cells;
}

/** The sheet as text for the model: its size and its cells, typed and computed. */
export function describeSheet(s: Pick<Sheet, "title" | "cells" | "cols" | "rows">): string {
  const vals = computeSheet(s.cells);
  const keys = Object.keys(s.cells).filter((a) => parseRef(a)).sort((a, b) => parseRef(a)!.r - parseRef(b)!.r || parseRef(a)!.c - parseRef(b)!.c);
  return [`Sheet "${s.title}" (${s.cols} columns × ${s.rows} rows), ${keys.length} cells:`, ...keys.slice(0, 3000).map((a) => (s.cells[a]!.startsWith("=") ? `${a}: ${s.cells[a]} → ${showValue(vals[a])}` : `${a}: ${s.cells[a]}`))].join("\n");
}

/**
 * Function graphs in answers (RESEARCH_LOG "Students, part 21" #4, like Desmos and ChatGPT's interactive math
 * visuals): a ```graph block with one function per line and optional sliders. Expressions are parsed here into
 * closures, never evaluated as code, so a model's block can only compute numbers.
 *
 *     ```graph
 *     y = a*sin(b*x)
 *     y = x^2/2 - 3
 *     x: -7..7
 *     y: -5..5
 *     a = 2 (0..5)
 *     b = 1.5 (0.1..4)
 *     ```
 */

/** A compiled expression: x and the sliders' values in, a number out (NaN where undefined). */
export type GraphFn = (x: number, vars: Record<string, number>) => number;

/** A slider: its name, start value and range. */
export interface GraphParam { name: string; value: number; min: number; max: number }

/** A parsed ```graph block. */
export interface GraphSpec {
  fns: Array<{ src: string; f: GraphFn }>;
  x: [number, number];
  y?: [number, number];
  params: GraphParam[];
}

const FUNCS: Record<string, (a: number) => number> = {
  sin: Math.sin, cos: Math.cos, tan: Math.tan, asin: Math.asin, acos: Math.acos, atan: Math.atan, arcsin: Math.asin, arccos: Math.acos, arctan: Math.atan,
  sinh: Math.sinh, cosh: Math.cosh, tanh: Math.tanh, exp: Math.exp, ln: Math.log, log: Math.log10, log2: Math.log2, sqrt: Math.sqrt, abs: Math.abs,
  floor: Math.floor, ceil: Math.ceil, round: Math.round, sign: Math.sign, cbrt: Math.cbrt,
};
const CONSTS: Record<string, number> = { pi: Math.PI, π: Math.PI, e: Math.E };

type Tok = { t: "num"; v: number } | { t: "id"; v: string } | { t: "op"; v: string };

function tokens(src: string): Tok[] {
  const s = src.replace(/[·×]/g, "*").replace(/−/g, "-").replace(/÷/g, "/").replace(/²/g, "^2").replace(/³/g, "^3").replace(/√/g, "sqrt");
  const out: Tok[] = [];
  const re = /\s*(?:(\d+\.?\d*(?:e[+-]?\d+)?|\.\d+)|([a-zA-Zπ_][a-zA-Z0-9_]*)|(\*\*|[-+*/^(),|]))/y;
  let i = 0;
  while (i < s.length) {
    if (/^\s*$/.test(s.slice(i))) break;
    re.lastIndex = i;
    const m = re.exec(s);
    if (!m) throw new Error(`Can't read "${s.slice(i, i + 8)}"`);
    i = re.lastIndex;
    if (m[1]) out.push({ t: "num", v: Number(m[1]) });
    else if (m[2]) out.push({ t: "id", v: m[2] });
    else out.push({ t: "op", v: m[3] === "**" ? "^" : m[3]! });
  }
  return out;
}

/**
 * Compiles an expression in x (and the given slider names) into a function. Implicit multiplication is allowed:
 * "2x", "3(x+1)", "a sin(x)". Throws on anything it does not know.
 *
 * @param src - The expression, e.g. "a*sin(b*x) + x^2/2".
 * @param names - The slider names it may use.
 */
export function compileExpr(src: string, names: string[] = []): GraphFn {
  const ts = tokens(src);
  let p = 0;
  const peek = () => ts[p];
  const isOp = (v: string) => peek()?.t === "op" && peek()!.v === v;
  const expect = (v: string) => {
    if (!isOp(v)) throw new Error(`Expected "${v}"`);
    p++;
  };
  // Precedence: + - < * / and implicit < unary - < ^ (right-assoc) < call/atom.
  const sum = (): GraphFn => {
    let l = product();
    while (isOp("+") || isOp("-")) {
      const op = (ts[p++] as { v: string }).v;
      const a = l;
      const b = product();
      l = op === "+" ? (x, v) => a(x, v) + b(x, v) : (x, v) => a(x, v) - b(x, v);
    }
    return l;
  };
  const startsAtom = () => {
    const t = peek();
    return !!t && (t.t === "num" || t.t === "id" || (t.t === "op" && (t.v === "(" || t.v === "|")));
  };
  const product = (): GraphFn => {
    let l = unary();
    for (;;) {
      if (isOp("*") || isOp("/")) {
        const op = (ts[p++] as { v: string }).v;
        const a = l;
        const b = unary();
        l = op === "*" ? (x, v) => a(x, v) * b(x, v) : (x, v) => a(x, v) / b(x, v);
      } else if (startsAtom() && !(isOp("|") && absDepth > 0)) {
        const a = l;
        const b = power();
        l = (x, v) => a(x, v) * b(x, v);
      } else return l;
    }
  };
  const unary = (): GraphFn => {
    if (isOp("-")) {
      p++;
      const a = unary();
      return (x, v) => -a(x, v);
    }
    if (isOp("+")) {
      p++;
      return unary();
    }
    return power();
  };
  const power = (): GraphFn => {
    const base = atom();
    if (isOp("^")) {
      p++;
      const ex = unary();
      return (x, v) => Math.pow(base(x, v), ex(x, v));
    }
    return base;
  };
  let absDepth = 0;
  const atom = (): GraphFn => {
    const t = ts[p++];
    if (!t) throw new Error("The expression ends too early");
    if (t.t === "num") return () => t.v;
    if (t.t === "op" && t.v === "(") {
      const e = sum();
      expect(")");
      return e;
    }
    if (t.t === "op" && t.v === "|") {
      absDepth++;
      const e = sum();
      absDepth--;
      expect("|");
      return (x, v) => Math.abs(e(x, v));
    }
    if (t.t === "id") {
      const id = t.v;
      const fn = FUNCS[id.toLowerCase()];
      if (fn) {
        // sin x, sin(x), sin^2(x)
        if (isOp("^")) {
          p++;
          const ex = atom();
          const arg = power();
          return (x, v) => Math.pow(fn(arg(x, v)), ex(x, v));
        }
        const arg = isOp("(") ? atom() : power();
        return (x, v) => fn(arg(x, v));
      }
      if (id === "x") return (x) => x;
      if (names.includes(id)) return (_x, v) => v[id] ?? NaN;
      const c = CONSTS[id];
      if (c !== undefined) return () => c;
      // "ax" written together: split into known one-letter names.
      if ([...id].every((ch) => ch === "x" || names.includes(ch))) {
        const parts = [...id].map((ch): GraphFn => (ch === "x" ? (x) => x : (_x, v) => v[ch] ?? NaN));
        return (x, v) => parts.reduce((m, f) => m * f(x, v), 1);
      }
      throw new Error(`Unknown name "${id}"`);
    }
    throw new Error(`Unexpected "${t.v}"`);
  };
  const f = sum();
  if (p < ts.length) throw new Error(`Unexpected "${(ts[p] as { v: unknown }).v}"`);
  return f;
}

const NUM = String.raw`-?(?:\d+\.?\d*|\.\d+|pi|π)`;
const num = (s: string) => (/^-?(pi|π)$/.test(s) ? (s.startsWith("-") ? -Math.PI : Math.PI) : Number(s));

/**
 * Reads a ```graph block. Returns undefined when nothing in it can be drawn (still being written, or not a graph).
 *
 * @param text - The block's text.
 */
export function parseGraph(text: string): GraphSpec | undefined {
  const lines = text.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#") && !l.startsWith("//"));
  const params: GraphParam[] = [];
  let x: [number, number] = [-10, 10];
  let y: [number, number] | undefined;
  const fnLines: string[] = [];
  const range = new RegExp(`^(${NUM})\\s*(?:\\.\\.|…|,|to)\\s*(${NUM})$`);
  for (const l of lines) {
    const r = /^([xy])\s*:\s*(.+)$/.exec(l);
    const rr = r && range.exec(r[2]!.trim().replace(/^\[|\]$/g, ""));
    if (r && rr) {
      const pair: [number, number] = [num(rr[1]!), num(rr[2]!)];
      if (pair[0] < pair[1]) {
        if (r[1] === "x") x = pair;
        else y = pair;
      }
      continue;
    }
    const pm = new RegExp(`^([a-wzA-Z])\\s*=\\s*(${NUM})\\s*(?:\\(\\s*(${NUM})\\s*(?:\\.\\.|…|,|to)\\s*(${NUM})\\s*\\))?$`).exec(l);
    if (pm && pm[1] !== "e") {
      const value = num(pm[2]!);
      const min = pm[3] !== undefined ? num(pm[3]) : Math.min(0, value * 2);
      const max = pm[4] !== undefined ? num(pm[4]) : Math.max(value * 2, 1);
      params.push({ name: pm[1]!, value, min: Math.min(min, value), max: Math.max(max, value) });
      continue;
    }
    fnLines.push(l);
  }
  const names = params.map((q) => q.name);
  const fns: GraphSpec["fns"] = [];
  for (const l of fnLines.slice(0, 8)) {
    const src = l.replace(/^(?:y|f\(x\)|[a-zA-Z]\(x\))\s*=\s*/, "");
    try {
      fns.push({ src: l, f: compileExpr(src, names) });
    } catch {
      // A line it cannot read is left out; the rest still draw.
    }
  }
  return fns.length ? { fns, x, ...(y ? { y } : {}), params } : undefined;
}

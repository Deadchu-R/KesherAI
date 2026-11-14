/**
 * C# expressions as pure nodes (board item: pure nodes in the C# graph), as Unreal draws them: a value a step takes
 * (`speed * Time.deltaTime`, `Vector3.Distance(a, b) < range`, `GetComponent<Rigidbody>()`) is a small graph of nodes
 * without flow pins, wired into the step's input, instead of one line of text. As Unreal's Math Expression node, the
 * text stays the truth: the nodes are read from it, and a change on a node writes the text again.
 *
 * Only what is understood becomes nodes; anything else (a lambda, a cast, `a ? b : c`) stays as text on its input.
 */

import type { CsNode, CsStmt } from "./csharp-graph.js";

/** One part of an expression. A path (`"0.1"`) names a part by the indexes of its children. */
export type CsExpr =
  | { kind: "lit"; src: string }
  | { kind: "raw"; src: string }
  | { kind: "name"; name: string }
  | { kind: "paren"; x: CsExpr }
  | { kind: "member"; target: CsExpr; name: string }
  | { kind: "call"; target?: CsExpr; name: string; generic?: string; args: CsExpr[] }
  | { kind: "new"; type: string; args: CsExpr[] }
  | { kind: "index"; target: CsExpr; arg: CsExpr }
  | { kind: "bin"; op: string; l: CsExpr; r: CsExpr }
  | { kind: "un"; op: string; x: CsExpr };

const BIN: Record<string, number> = { "||": 1, "&&": 2, "|": 3, "^": 4, "&": 5, "==": 6, "!=": 6, "<": 7, ">": 7, "<=": 7, ">=": 7, "<<": 8, ">>": 8, "+": 9, "-": 9, "*": 10, "/": 10, "%": 10 };
const TOKEN = /\s*(?:(@?"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?[fFdDmMuUlL]*|\.\d+[fFdDmM]?|[A-Za-z_][A-Za-z0-9_]*|\|\||&&|==|!=|<=|>=|<<|>>|=>|\?\?|[-+*/%<>!&|^~().,[\]?:{}=])|(\S))/y;

/** Splits C# into tokens, or undefined when something is not understood. */
function tokens(src: string): string[] | undefined {
  const out: string[] = [];
  TOKEN.lastIndex = 0;
  while (TOKEN.lastIndex < src.length) {
    const at = TOKEN.lastIndex;
    const m = TOKEN.exec(src);
    if (!m) {
      if (/^\s*$/.test(src.slice(at))) break;
      return undefined;
    }
    if (m[2]) return undefined;
    if (m[1] !== undefined) out.push(m[1]);
  }
  return out;
}

const isIdent = (t: string | undefined) => !!t && /^[A-Za-z_]/.test(t);
const KEYWORD_LITS = new Set(["true", "false", "null", "this", "default"]);

/**
 * Reads an expression into parts.
 *
 * @param src - The C# text of one value.
 * @returns The parts, or a single `raw` part when the text is not understood (it then stays as text).
 */
export function parseExpr(src: string): CsExpr {
  const raw: CsExpr = { kind: "raw", src: src.trim() };
  const t = tokens(src);
  if (!t || !t.length || t.some((x) => ["=>", "?", ":", "{", "}", "=", "??"].includes(x))) return raw;
  let i = 0;
  const peek = () => t[i];
  const take = (want?: string) => {
    const v = t[i];
    if (want !== undefined && v !== want) throw new Error("x");
    i++;
    return v!;
  };
  // A type after `new` or inside <...>: dotted names and simple generics.
  const typeName = (): string => {
    let s = take();
    if (!isIdent(s)) throw new Error("x");
    while (peek() === "." && isIdent(t[i + 1])) s += take() + take();
    if (peek() === "<") s += generic();
    if (peek() === "[" && t[i + 1] === "]") s += take() + take();
    return s;
  };
  const generic = (): string => {
    let s = take("<");
    s += typeName();
    while (peek() === ",") s += `${take()} ${typeName()}`;
    return s + take(">");
  };
  // Whether `<` here opens type arguments of a call (`GetComponent<Rigidbody>()`), not a comparison.
  const genericCall = (): boolean => {
    let d = 0;
    for (let j = i; j < t.length; j++) {
      const x = t[j]!;
      if (x === "<") d++;
      else if (x === ">") {
        if (--d === 0) return t[j + 1] === "(";
      } else if (!(isIdent(x) || x === "." || x === "," || x === "[" || x === "]")) return false;
    }
    return false;
  };
  const args = (): CsExpr[] => {
    take("(");
    const list: CsExpr[] = [];
    if (peek() === ")") {
      take();
      return list;
    }
    for (;;) {
      if (peek() === "ref" || peek() === "out" || peek() === "in") throw new Error("x");
      list.push(bin(0));
      if (peek() === ",") take();
      else break;
    }
    take(")");
    return list;
  };
  const primary = (): CsExpr => {
    const x = peek();
    if (x === undefined) throw new Error("x");
    if (x === "(") {
      take();
      const inner = bin(0);
      take(")");
      // `(float)x` is a cast: kept as text.
      if (inner.kind === "name" && (isIdent(peek()) || peek() === "(")) throw new Error("x");
      return { kind: "paren", x: inner };
    }
    if (x === "new") {
      take();
      const type = typeName();
      if (peek() !== "(") throw new Error("x");
      return { kind: "new", type, args: args() };
    }
    if (/^[@"'\d.]/.test(x) || KEYWORD_LITS.has(x)) {
      take();
      return { kind: "lit", src: x };
    }
    if (isIdent(x)) {
      take();
      if (peek() === "<" && genericCall()) {
        const g = generic();
        return { kind: "call", name: x, generic: g, args: args() };
      }
      if (peek() === "(") return { kind: "call", name: x, args: args() };
      return { kind: "name", name: x };
    }
    throw new Error("x");
  };
  const postfix = (): CsExpr => {
    let e = primary();
    for (;;) {
      if (peek() === "." && isIdent(t[i + 1])) {
        take();
        const name = take();
        if (peek() === "<" && genericCall()) {
          const g = generic();
          e = { kind: "call", target: e, name, generic: g, args: args() };
        } else if (peek() === "(") e = { kind: "call", target: e, name, args: args() };
        else e = { kind: "member", target: e, name };
      } else if (peek() === "[") {
        take();
        const a = bin(0);
        take("]");
        e = { kind: "index", target: e, arg: a };
      } else return e;
    }
  };
  const unary = (): CsExpr => {
    const x = peek();
    if (x === "!" || x === "-" || x === "~" || x === "+") {
      take();
      const inner = unary();
      // -5 is one number.
      if (x === "-" && inner.kind === "lit" && /^\d|^\./.test(inner.src)) return { kind: "lit", src: `-${inner.src}` };
      return { kind: "un", op: x, x: inner };
    }
    return postfix();
  };
  const bin = (min: number): CsExpr => {
    let l = unary();
    for (;;) {
      const op = peek();
      const p = op !== undefined ? BIN[op] : undefined;
      if (p === undefined || p < min + 1) return l;
      take();
      const r = bin(p);
      l = { kind: "bin", op: op!, l, r };
    }
  };
  try {
    const e = bin(0);
    if (i !== t.length) return raw;
    return e;
  } catch {
    return raw;
  }
}

/** Writes parts back as C#. */
export function writeExpr(e: CsExpr): string {
  switch (e.kind) {
    case "lit":
    case "raw":
      return e.src;
    case "name":
      return e.name;
    case "paren":
      return `(${writeExpr(e.x)})`;
    case "member":
      return `${wrap(e.target, 12)}.${e.name}`;
    case "call":
      return `${e.target ? `${wrap(e.target, 12)}.` : ""}${e.name}${e.generic ?? ""}(${e.args.map(writeExpr).join(", ")})`;
    case "new":
      return `new ${e.type}(${e.args.map(writeExpr).join(", ")})`;
    case "index":
      return `${wrap(e.target, 12)}[${writeExpr(e.arg)}]`;
    case "un":
      return `${e.op}${wrap(e.x, 11)}`;
    case "bin":
      return `${wrap(e.l, BIN[e.op]!)} ${e.op} ${wrap(e.r, BIN[e.op]! + 1)}`;
  }
}

/** A part as written inside an operator of strength `p` (in brackets when it binds less tightly). */
function wrap(e: CsExpr, p: number): string {
  const s = writeExpr(e);
  if ((e.kind === "bin" && BIN[e.op]! < p) || (e.kind === "un" && p > 11)) return `(${s})`;
  if (e.kind === "raw" && /[\s?:]/.test(s)) return `(${s})`;
  return s;
}

/** A dotted chain of plain names (`transform.position`, `Time.deltaTime`), or undefined. */
export function chainOf(e: CsExpr): string | undefined {
  if (e.kind === "name") return e.name;
  if (e.kind === "member") {
    const t = chainOf(e.target);
    return t === undefined ? undefined : `${t}.${e.name}`;
  }
  return undefined;
}

/** Whether a chain names a type or static class (`Time`, `Mathf`, `Vector3.up`'s `Vector3`) rather than a value. */
const typeLike = (name: string) => /^[A-Z]/.test(name);

/** Whether a part is drawn as a node (otherwise it stays as text on the input). */
export function isNodeExpr(e: CsExpr): boolean {
  if (e.kind === "paren") return isNodeExpr(e.x);
  if (e.kind === "lit" || e.kind === "raw") return false;
  // A static class alone (`Debug`) is a target, not a value.
  if (e.kind === "name") return !typeLike(e.name) && e.name !== "_";
  return true;
}

/** An input of a pure node: its pin name and the part that feeds it. */
export interface ExprInput {
  pin: string;
  label?: string;
  type: string;
  /** The child's index (its path step). */
  index: number;
  e: CsExpr;
}

/** The children of a part, in path order. */
export function exprChildren(e: CsExpr): CsExpr[] {
  switch (e.kind) {
    case "paren":
      return [e.x];
    case "member":
      return [e.target];
    case "call":
      return e.target ? [e.target, ...e.args] : e.args;
    case "new":
      return e.args;
    case "index":
      return [e.target, e.arg];
    case "bin":
      return [e.l, e.r];
    case "un":
      return [e.x];
    default:
      return [];
  }
}

/** The part at a path (`""` is the whole). */
export function exprAt(e: CsExpr, path: string): CsExpr | undefined {
  let cur: CsExpr | undefined = e;
  for (const s of path ? path.split(".") : []) cur = cur ? exprChildren(cur)[Number(s)] : undefined;
  return cur;
}

/** The whole with the part at `path` replaced (a new tree; the old is not changed). */
export function replaceAt(e: CsExpr, path: string, by: CsExpr): CsExpr {
  if (!path) return by;
  const [head, ...rest] = path.split(".");
  const k = Number(head);
  const sub = (x: CsExpr) => replaceAt(x, rest.join("."), by);
  switch (e.kind) {
    case "paren":
      return { ...e, x: sub(e.x) };
    case "member":
      return { ...e, target: sub(e.target) };
    case "call":
      if (e.target) return k === 0 ? { ...e, target: sub(e.target) } : { ...e, args: e.args.map((a, j) => (j === k - 1 ? sub(a) : a)) };
      return { ...e, args: e.args.map((a, j) => (j === k ? sub(a) : a)) };
    case "new":
      return { ...e, args: e.args.map((a, j) => (j === k ? sub(a) : a)) };
    case "index":
      return k === 0 ? { ...e, target: sub(e.target) } : { ...e, arg: sub(e.arg) };
    case "bin":
      return k === 0 ? { ...e, l: sub(e.l) } : { ...e, r: sub(e.r) };
    case "un":
      return { ...e, x: sub(e.x) };
    default:
      return e;
  }
}

const OP_NAMES: Record<string, string> = { "+": "+", "-": "−", "*": "×", "/": "÷", "%": "%", "==": "==", "!=": "!=", "<": "<", ">": ">", "<=": "<=", ">=": ">=", "&&": "AND", "||": "OR", "&": "&", "|": "|", "^": "XOR", "<<": "<<", ">>": ">>" };
const BOOL_OPS = new Set(["==", "!=", "<", ">", "<=", ">=", "&&", "||"]);

/** How a part looks as a node: its title, Unreal class, inputs and output type. */
export function exprNode(e: CsExpr): { title: string; class: string; comment?: string; inputs: ExprInput[]; out: string } {
  const kids = exprChildren(e);
  const input = (k: number, pin: string, type = "wildcard", label?: string): ExprInput => ({ pin, type, index: k, e: kids[k]!, ...(label ? { label } : {}) });
  switch (e.kind) {
    case "paren":
      return exprNode(e.x);
    case "name":
      return { title: `Get ${e.name}`, class: "K2Node_VariableGet", inputs: [], out: "wildcard" };
    case "member": {
      const chain = chainOf(e);
      if (chain !== undefined) return { title: `Get ${chain}`, class: "K2Node_VariableGet", inputs: [], out: "wildcard" };
      return { title: `Get ${e.name}`, class: "K2Node_VariableGet", inputs: [input(0, "Target", "object")], out: "wildcard" };
    }
    case "call": {
      // A static class or a chain of names as the target is part of the title (Mathf.Clamp, transform.TransformPoint).
      const chain = e.target ? chainOf(e.target) : undefined;
      const inTitle = e.target && chain !== undefined && (typeLike(chain) || !isNodeExpr(e.target));
      const off = e.target ? 1 : 0;
      const ins = [...(e.target && !inTitle ? [input(0, "Target", "object")] : []), ...e.args.map((_, j) => input(j + off, `arg${j}`, "wildcard", `Arg ${j + 1}`))];
      return { title: `${inTitle ? `${chain}.` : ""}${e.name}${e.generic ?? ""}`, class: "K2Node_CallFunction_Pure", inputs: ins, out: "wildcard" };
    }
    case "new":
      return { title: `Make ${e.type}`, class: "K2Node_MakeStruct", inputs: e.args.map((_, j) => input(j, `arg${j}`, "wildcard", `Arg ${j + 1}`)), out: e.type.toLowerCase() };
    case "index":
      return { title: "Get [ ]", class: "K2Node_GetArrayItem", inputs: [input(0, "Target", "object", "Array"), input(1, "Index", "int")], out: "wildcard" };
    case "un":
      return { title: e.op === "!" ? "NOT" : e.op === "-" ? "Negate" : e.op, class: "K2Node_PromotableOperator", inputs: [input(0, "A", e.op === "!" ? "bool" : "wildcard")], out: e.op === "!" ? "bool" : "wildcard" };
    case "bin": {
      const b = e.op === "&&" || e.op === "||" ? "bool" : "wildcard";
      return { title: OP_NAMES[e.op] ?? e.op, class: "K2Node_PromotableOperator", inputs: [input(0, "A", b), input(1, "B", b)], out: BOOL_OPS.has(e.op) ? "bool" : "wildcard" };
    }
    default:
      return { title: writeExpr(e), class: "K2Node_Code", inputs: [], out: "wildcard" };
  }
}

/** Removes brackets that are only around the whole (a node shows the part itself). */
export function unparen(e: CsExpr): CsExpr {
  return e.kind === "paren" ? unparen(e.x) : e;
}

/** The pure node id for a part: `<step id>~<input pin>~<path>`. */
export const pureId = (step: string, pin: string, path: string) => `${step}~${pin}~${path}`;

/** Reads a pure node id back (undefined when the id is a step's). */
export function parsePureId(id: string): { step: string; pin: string; path: string } | undefined {
  const a = id.indexOf("~");
  if (a < 0) return undefined;
  const b = id.indexOf("~", a + 1);
  if (b < 0) return undefined;
  return { step: id.slice(0, a), pin: id.slice(a + 1, b), path: id.slice(b + 1) };
}

/**
 * The graph with each step's values drawn as pure nodes wired into its inputs (as Unreal draws them: to the left of
 * the step, below its row). An input whose value is plain text (a number, a string, what is not understood) keeps it
 * as its default. A node goes where it was put (`positions`, by its key).
 *
 * @param nodes - The method's nodes (steps and entry), as methodToNodes makes them.
 * @param positions - Saved places by key.
 */
export function withPureNodes(nodes: CsNode[], positions?: Record<string, { x: number; y: number }>): CsNode[] {
  const out: CsNode[] = [];
  for (const n of nodes) {
    out.push(n);
    if (n.class === "K2Node_Event" || n.class === "K2Node_FunctionEntry" || n.id.includes("~")) continue;
    let slot = 0;
    for (const pin of n.pins) {
      if (pin.dir !== "in" || pin.type === "exec" || pin.default === undefined) continue;
      const whole = parseExpr(pin.default);
      if (!isNodeExpr(whole)) continue;
      const build = (e: CsExpr, path: string, into: { node: string; pin: string; ref: CsNode["pins"][number] }, depth: number): void => {
        // Brackets are the same node as what they hold.
        while (e.kind === "paren") {
          e = e.x;
          path = path ? `${path}.0` : "0";
        }
        const look = exprNode(e);
        const id = pureId(n.id, pin.name, path);
        const key = n.key ? `${n.key}~${pin.name}~${path}` : undefined;
        const p = key ? positions?.[key] : undefined;
        const node: CsNode = {
          id,
          title: look.title,
          class: look.class,
          x: p ? p.x : n.x - 250 * depth,
          y: p ? p.y : n.y + 110 + slot * 64,
          pins: [{ name: "ReturnValue", label: "", dir: "out", type: look.out, links: [`${into.node}:${into.pin}`] }],
          ...(key ? { key } : {}),
          ...(n.detached ? { detached: true } : {}),
        };
        slot++;
        (into.ref.links ??= []).push(`${id}:ReturnValue`);
        delete into.ref.default;
        out.push(node);
        for (const inp of look.inputs) {
          const sub = path ? `${path}.${inp.index}` : String(inp.index);
          const pr: CsNode["pins"][number] = { name: inp.pin, dir: "in", type: inp.type, ...(inp.label ? { label: inp.label } : {}), default: writeExpr(inp.e) };
          node.pins.splice(node.pins.length - 1, 0, pr);
          if (isNodeExpr(inp.e)) build(inp.e, sub, { node: id, pin: inp.pin, ref: pr }, depth + 1);
        }
      };
      build(whole, "", { node: n.id, pin: pin.name, ref: pin }, 1);
    }
  }
  return out;
}

/** The text a step's input holds (undefined when the input is not a value). */
export function stepValue(s: CsStmt, pin: string): string | undefined {
  if (s.kind === "call" && /^arg\d+$/.test(pin)) return s.args[Number(pin.slice(3))];
  if (s.kind === "call" && pin === "Target") return s.target;
  if ((s.kind === "set" || s.kind === "local" || s.kind === "return") && pin === "value") return s.value;
  if (s.kind === "if" && pin === "Condition") return s.cond;
  return undefined;
}

/** Writes a step's input (returns false when the input is not a value). Marks the step changed. */
export function setStepValue(s: CsStmt, pin: string, v: string): boolean {
  if (s.kind === "call" && /^arg\d+$/.test(pin) && Number(pin.slice(3)) < s.args.length) s.args[Number(pin.slice(3))] = v;
  else if (s.kind === "call" && pin === "Target") s.target = v;
  else if ((s.kind === "set" || s.kind === "local" || s.kind === "return") && pin === "value") (s as { value: string }).value = v;
  else if (s.kind === "if" && pin === "Condition") s.cond = v;
  else return false;
  s.dirty = true;
  return true;
}

/**
 * Where a pure node's input (or the node itself, with no pin) is in its step's value: the step's input and the path.
 *
 * @param id - The pure node's id.
 * @param value - The step input's current text.
 * @param pin - One of the pure node's inputs, or undefined for the node itself.
 */
export function purePath(id: string, value: string, pin?: string): { stepPin: string; path: string; type: string } | undefined {
  const p = parsePureId(id);
  if (!p) return undefined;
  if (pin === undefined || pin === "ReturnValue") return { stepPin: p.pin, path: p.path, type: "wildcard" };
  const part = exprAt(parseExpr(value), p.path);
  const inp = part ? exprNode(part).inputs.find((x) => x.pin === pin) : undefined;
  if (!inp) return undefined;
  return { stepPin: p.pin, path: p.path ? `${p.path}.${inp.index}` : String(inp.index), type: inp.type };
}

/** A step input's text with the part at `path` replaced by C# text (the text parsed as one part). */
export function replaceValueAt(value: string, path: string, text: string): string {
  return writeExpr(replaceAt(parseExpr(value), path, parseExpr(text)));
}

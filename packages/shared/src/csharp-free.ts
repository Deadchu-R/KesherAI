/**
 * A C# method edited as a free graph, the way Unreal's Blueprint editor works (Roee, 2026-11-14: "place a node
 * alone, unconnected, and arrange it as I like"):
 * - a node from the menu lands where it was asked for, wired to nothing; it is kept on the graph (in the script's
 *   layout, not in the code) and does not run, like an unconnected node in Unreal;
 * - wiring an exec pin to it puts it, with every step after it, into the code at that point; the steps that
 *   followed that pin before are cut loose (an exec output has one wire, as in Unreal) and stay on the graph;
 * - breaking an exec wire takes the step and the ones after it out of the code, onto the graph.
 * Only what is wired from the method's entry is written as C#.
 */
import type { CsDetached, CsKnot, CsLayout, CsMethod, CsNode, CsStmt } from "./csharp-graph.js";

let nextDetached = 0;

/** A copy of a step (and the steps inside it) with ids of the graph's own (never a parsed file's s1, s2…). */
export function reId(s: CsStmt): CsStmt {
  const c = { ...s, id: `d${++nextDetached}`, dirty: true } as CsStmt;
  if (c.kind === "if") {
    c.then = c.then.map(reId);
    if (c.else) c.else = c.else.map(reId);
  } else if (c.kind === "loop") c.body = c.body.map(reId);
  return c;
}

/** Where a step is: in a list of the code (or of an unwired chain), at an index. */
export interface StepPlace {
  list: CsStmt[];
  index: number;
  stmt: CsStmt;
  /** The unwired chain it is in, when it is not in the code. */
  chain?: CsDetached;
}

function findIn(list: CsStmt[], id: string): { list: CsStmt[]; index: number; stmt: CsStmt } | undefined {
  for (let i = 0; i < list.length; i++) {
    const s = list[i]!;
    if (s.id === id) return { list, index: i, stmt: s };
    const inner = s.kind === "if" ? findIn(s.then, id) ?? (s.else ? findIn(s.else, id) : undefined) : s.kind === "loop" ? findIn(s.body, id) : undefined;
    if (inner) return inner;
  }
  return undefined;
}

/** Finds a step in the method's code or in its unwired chains. */
export function locate(m: CsMethod, layout: CsLayout, id: string): StepPlace | undefined {
  const inCode = findIn(m.body, id);
  if (inCode) return inCode;
  for (const chain of layout.detached?.[m.name] ?? []) {
    const f = findIn(chain.stmts, id);
    if (f) return { ...f, chain };
  }
  return undefined;
}

function chains(m: CsMethod, layout: CsLayout): CsDetached[] {
  layout.detached ??= {};
  return (layout.detached[m.name] ??= []);
}

function dropEmpty(m: CsMethod, layout: CsLayout): void {
  const list = layout.detached?.[m.name];
  if (list) layout.detached![m.name] = list.filter((c) => c.stmts.length > 0);
}

/** Marks the method (and the step after a change) for writing. */
function touched(m: CsMethod, list: CsStmt[], at: number): void {
  (m as CsMethod & { dirty?: boolean }).dirty = true;
  const next = list[at];
  if (next) next.dirty = true;
}

/**
 * A new step placed alone on the graph at (x, y): not wired, not in the code.
 *
 * @returns Its id.
 */
export function placeAlone(m: CsMethod, layout: CsLayout, stmt: CsStmt, x: number, y: number): string {
  const s = reId(stmt);
  chains(m, layout).push({ x, y, stmts: [s] });
  return s.id;
}

/**
 * Takes a step and every step after it in its list out of where it is (code or chain), as a new unwired chain at
 * (x, y). In the code, that is breaking the exec wire into it.
 */
export function detachFrom(m: CsMethod, layout: CsLayout, id: string, x: number, y: number): boolean {
  const at = locate(m, layout, id);
  if (!at) return false;
  if (at.chain && at.chain.stmts === at.list && at.index === 0) return true;
  const tail = at.list.splice(at.index);
  if (!at.chain) touched(m, at.list, at.index);
  chains(m, layout).push({ x, y, stmts: tail.map((s) => (at.chain ? s : reId(s))) });
  dropEmpty(m, layout);
  return true;
}

/** The list and index an exec output pin leads into: after the step, or first in its True/False/Loop Body. */
function destination(m: CsMethod, layout: CsLayout, node: string, pin: string): { list: CsStmt[]; at: number; chain?: CsDetached } | undefined {
  if (node === m.id) return { list: m.body, at: 0 };
  const src = locate(m, layout, node);
  if (!src) return undefined;
  const s = src.stmt;
  if (s.kind === "if" && pin === "True") return { list: s.then, at: 0, ...(src.chain ? { chain: src.chain } : {}) };
  if (s.kind === "if" && pin === "False") return { list: (s.else ??= []), at: 0, ...(src.chain ? { chain: src.chain } : {}) };
  if (s.kind === "loop" && pin === "Loop Body") return { list: s.body, at: 0, ...(src.chain ? { chain: src.chain } : {}) };
  return { list: src.list, at: src.index + 1, ...(src.chain ? { chain: src.chain } : {}) };
}

/** Whether `inner` is `outer` or inside it. */
function contains(outer: CsStmt, inner: string): boolean {
  if (outer.id === inner) return true;
  if (outer.kind === "if") return [...outer.then, ...(outer.else ?? [])].some((s) => contains(s, inner));
  if (outer.kind === "loop") return outer.body.some((s) => contains(s, inner));
  return false;
}

/**
 * Wires an exec output pin to a step's exec input, as in Unreal: the step and the steps after it move to that
 * point; what followed the pin before is cut loose onto the graph at `loose` (an exec output has one wire).
 *
 * @param loose - Where the cut-loose steps go on the graph.
 * @returns An error in words, or undefined when done.
 */
export function wireExec(m: CsMethod, layout: CsLayout, from: { node: string; pin: string }, to: string, loose: { x: number; y: number }): string | undefined {
  const target = locate(m, layout, to);
  if (!target) return "The step to wire into was not found.";
  if (from.node === to) return "A step cannot wire into itself.";
  // The target's tail moves: the pin must not be inside it.
  const tailIds = target.list.slice(target.index);
  if (from.node !== m.id && tailIds.some((s) => contains(s, from.node))) return "A step cannot wire back into the steps that lead to it.";
  const dest = destination(m, layout, from.node, from.pin);
  if (!dest) return "The step the wire starts from was not found.";
  // Already wired so: nothing to do.
  if (dest.list === target.list && dest.at === target.index) return undefined;
  // What followed the pin is cut loose (kept on the graph).
  const was = dest.list.splice(dest.at);
  const fromCode = !target.chain;
  // Take the target's tail out of where it is (its list may be the one just cut).
  let tail: CsStmt[];
  const inWas = was.findIndex((s) => s.id === to);
  if (inWas >= 0) {
    tail = was.splice(inWas);
  } else {
    const again = locate(m, layout, to)!;
    tail = again.list.splice(again.index);
    if (!again.chain) touched(m, again.list, again.index);
  }
  if (was.length) chains(m, layout).push({ x: loose.x, y: loose.y, stmts: dest.chain ? was : was.map(reId) });
  const intoCode = !dest.chain;
  dest.list.splice(dest.at, 0, ...(intoCode && !fromCode ? tail.map((s) => ({ ...s, dirty: true })) : tail));
  if (intoCode) {
    for (const s of tail) s.dirty = true;
    touched(m, dest.list, dest.at + tail.length);
  }
  dropEmpty(m, layout);
  return undefined;
}

/**
 * Breaks the exec wire at a pin: on a step's input, it and the steps after it leave the code; on an output, the
 * steps that followed it do.
 */
export function breakExec(m: CsMethod, layout: CsLayout, node: string, pin: string, dir: "in" | "out", where: { x: number; y: number }): boolean {
  if (dir === "in") return detachFrom(m, layout, node, where.x, where.y);
  const dest = destination(m, layout, node, pin);
  const next = dest?.list[dest.at];
  return next ? detachFrom(m, layout, next.id, where.x, where.y) : true;
}

/** Deletes a step wherever it is. */
export function deleteStep(m: CsMethod, layout: CsLayout, id: string): boolean {
  const at = locate(m, layout, id);
  if (!at) return false;
  at.list.splice(at.index, 1);
  if (!at.chain) touched(m, at.list, at.index);
  dropEmpty(m, layout);
  return true;
}

/** Whether an id is a reroute node's (they are only on the graph). */
export const isKnotId = (id: string): boolean => id.startsWith("knot-");

/**
 * The graph with its reroute nodes: each splits its wire in two through a dot (a node of class K2Node_Knot, the way
 * the canvas draws Unreal's). A reroute node whose wire is gone (the wire was broken or rewired) is dropped.
 *
 * @returns The nodes to draw, and the reroute nodes still on a wire (to keep).
 */
export function withKnots(nodes: CsNode[], knots: CsKnot[]): { nodes: CsNode[]; live: CsKnot[] } {
  const all = nodes.map((n) => ({ ...n, pins: n.pins.map((p) => ({ ...p, ...(p.links ? { links: [...p.links] } : {}) })) }));
  const byId = new Map(all.map((n) => [n.id, n]));
  const pinOf = (ref: string, dir: "in" | "out") => {
    const at = ref.lastIndexOf(":");
    return byId.get(ref.slice(0, at))?.pins.find((p) => p.name === ref.slice(at + 1) && p.dir === dir);
  };
  const live: CsKnot[] = [];
  for (const k of knots) {
    const out = pinOf(k.from, "out");
    const i = out?.links?.indexOf(k.to) ?? -1;
    if (!out || i < 0) continue;
    out.links![i] = `${k.id}:InputPin`;
    const into = pinOf(k.to, "in");
    if (into?.links) into.links = into.links.map((l) => (l === k.from ? `${k.id}:OutputPin` : l));
    const knot: CsNode = {
      id: k.id,
      title: "",
      class: "K2Node_Knot",
      x: k.x,
      y: k.y,
      pins: [
        { name: "InputPin", dir: "in", type: out.type, links: [k.from] },
        { name: "OutputPin", dir: "out", type: out.type, links: [k.to] },
      ],
    };
    all.push(knot);
    byId.set(k.id, knot);
    live.push(k);
  }
  return { nodes: all, live };
}

/**
 * The real pin behind a reroute node's pin: its OutputPin stands for the wire's source, its InputPin for the wire's
 * end (followed through other reroute nodes).
 */
export function realPin(knots: CsKnot[], ref: string): string {
  for (let i = 0; i < 32; i++) {
    const at = ref.lastIndexOf(":");
    const k = knots.find((x) => x.id === ref.slice(0, at));
    if (!k) return ref;
    ref = ref.slice(at + 1) === "OutputPin" ? k.from : k.to;
  }
  return ref;
}

let nextKnot = 0;

/**
 * A reroute node on the wire from `from` to `to` (as drawn, so either may be another reroute node's pin).
 *
 * @returns Its id.
 */
export function addKnot(layout: CsLayout, method: string, from: string, to: string, x: number, y: number): string {
  const list = ((layout.knots ??= {})[method] ??= []);
  let id = `knot-${Date.now().toString(36)}${++nextKnot}`;
  while (list.some((k) => k.id === id)) id = `knot-${Date.now().toString(36)}${++nextKnot}`;
  list.push({ id, x, y, from, to });
  return id;
}

/** Removes a reroute node: the wire through it runs straight again. */
export function removeKnot(layout: CsLayout, method: string, id: string): boolean {
  const list = layout.knots?.[method];
  const k = list?.find((x) => x.id === id);
  if (!list || !k) return false;
  for (const o of list) {
    if (o.from === `${id}:OutputPin`) o.from = k.from;
    if (o.to === `${id}:InputPin`) o.to = k.to;
  }
  layout.knots![method] = list.filter((x) => x !== k);
  return true;
}

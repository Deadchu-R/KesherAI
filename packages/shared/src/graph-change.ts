/**
 * What a change to a visual-script graph (Unreal Blueprint, Unity Script Graph) did or would do, in a small form the
 * chat can show: the card's "+3 nodes, 2 links", the diff view's highlighted nodes, and a proposal the user reviews
 * change by change (the chat's Blueprint surface). The graph tools write one `[graph-change]` or `[graph-proposal]`
 * line at the end of their result; the web surface reads it with {@link parseGraphChange} / {@link parseProposal}.
 * Pure functions, no I/O.
 */
import { applyBpOps, bpNodeTemplate, type BpDoc, type BpNode, type BpOp } from "./unreal-bp.js";

/** One node named in a change: its id in the graph, title and class. */
export interface ChangeNode { id: string; title: string; class: string }

/** What a change did to a graph, compared node by node (ids). Lists hold at most 40 nodes each. */
export interface GraphChange {
  /** The asset's path and the graph (tab) inside it. */
  path: string;
  graph: string;
  kind: "unreal" | "unity";
  /** The nodes the graph has after the change. */
  nodes: number;
  added: ChangeNode[];
  removed: ChangeNode[];
  /** Nodes that stayed but were rewired, got a new value or comment, or moved. */
  changed: ChangeNode[];
  /** Links made and links cut. */
  links: number;
  unlinked: number;
}

/** One change of a proposal: the operation as the bridge takes it, its words, and the earlier changes it needs. */
export interface ProposalItem { op: BpOp; label: string; needs: number[] }

/** A change the model proposed and did not apply yet. */
export interface Proposal { path: string; graph: string; kind: "unreal" | "unity"; note: string; items: ProposalItem[] }

const CAP = 40;
const TAG_CHANGE = "[graph-change] ";
const TAG_PROPOSAL = "[graph-proposal] ";

const linkSet = (n: BpNode) => new Set(n.pins.filter((p) => p.dir === "out").flatMap((p) => (p.links ?? []).map((l) => `${n.id}.${p.name}>${l}`)));
const valueKey = (n: BpNode) => n.pins.map((p) => `${p.name}=${p.default ?? ""}`).join("|") + `|${n.title}|${n.comment ?? ""}|${Math.round(n.x)},${Math.round(n.y)}`;
const brief = (n: BpNode): ChangeNode => ({ id: n.id, title: n.title, class: n.class });

/**
 * Compares one graph before and after a change, by node id.
 *
 * @param before - The Blueprint (or Script Graph) as it was; `after` as it is now.
 * @param graph - Which graph (tab) inside it; the first when it is not found.
 * @param kind - Unreal or Unity (only carried to the result).
 * @returns The nodes added, removed and changed, and how many links were made and cut.
 */
export function summarizeChange(before: BpDoc, after: BpDoc, graph: string, kind: "unreal" | "unity" = "unreal"): GraphChange {
  const a = after.graphs.find((g) => g.name === graph) ?? after.graphs[0];
  const b = before.graphs.find((g) => g.name === (a?.name ?? graph)) ?? before.graphs[0];
  const was = new Map((b?.nodes ?? []).map((n) => [n.id, n]));
  const now = new Map((a?.nodes ?? []).map((n) => [n.id, n]));
  const out: GraphChange = { path: after.path || before.path, graph: a?.name ?? graph, kind, nodes: now.size, added: [], removed: [], changed: [], links: 0, unlinked: 0 };
  const links = (m: Map<string, BpNode>) => new Set([...m.values()].flatMap((n) => [...linkSet(n)]));
  const l0 = links(was);
  const l1 = links(now);
  for (const l of l1) if (!l0.has(l)) out.links++;
  for (const l of l0) if (!l1.has(l)) out.unlinked++;
  for (const [id, n] of now) {
    const old = was.get(id);
    if (!old) out.added.push(brief(n));
    else if (valueKey(old) !== valueKey(n) || [...linkSet(old)].join() !== [...linkSet(n)].join()) out.changed.push(brief(n));
  }
  for (const [id, n] of was) if (!now.has(id)) out.removed.push(brief(n));
  for (const k of ["added", "removed", "changed"] as const) out[k] = out[k].slice(0, CAP);
  return out;
}

/**
 * The card's short line for a change: "+3 nodes, 2 links" (also "-1 node", "2 changed", "no change").
 *
 * @param c - The change; `he` writes it in Hebrew.
 */
export function changeLabel(c: Pick<GraphChange, "added" | "removed" | "changed" | "links" | "unlinked">, he: boolean): string {
  const n = (k: number, one: string, many: string, oneHe: string, manyHe: string) => (he ? (k === 1 ? oneHe : `${k} ${manyHe}`) : `${k} ${k === 1 ? one : many}`);
  const parts: string[] = [];
  if (c.added.length) parts.push(`+${n(c.added.length, "node", "nodes", "נוד", "נודים")}`);
  if (c.removed.length) parts.push(`-${n(c.removed.length, "node", "nodes", "נוד", "נודים")}`);
  if (c.links) parts.push(`+${n(c.links, "link", "links", "קישור", "קישורים")}`);
  if (c.unlinked) parts.push(`-${n(c.unlinked, "link", "links", "קישור", "קישורים")}`);
  if (c.changed.length) parts.push(he ? `${c.changed.length} שונו` : `${c.changed.length} changed`);
  return parts.join(", ") || (he ? "ללא שינוי" : "no change");
}

/**
 * The line a graph tool appends to its result so the chat can draw the card.
 *
 * @param c - The change.
 * @returns "[graph-change] {json}" on one line.
 */
export function changeLine(c: GraphChange): string {
  return TAG_CHANGE + JSON.stringify(c);
}

/** Reads `[graph-xxx] {json}` out of a tool result, or undefined when it is missing or not an object. */
function taggedJson(output: string, tag: string): Record<string, unknown> | undefined {
  const i = output.lastIndexOf(tag);
  if (i < 0) return undefined;
  const end = output.indexOf("\n", i);
  try {
    const v: unknown = JSON.parse(output.slice(i + tag.length, end < 0 ? undefined : end));
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The change a `unreal_change_graph` / `unity_change_graph` result describes.
 *
 * @param output - The tool's result text.
 * @returns The change, or undefined when the result has none (a failure, or an older tool).
 */
export function parseGraphChange(output: string): GraphChange | undefined {
  const j = taggedJson(output, TAG_CHANGE);
  if (!j || typeof j.path !== "string" || !Array.isArray(j.added) || !Array.isArray(j.removed) || !Array.isArray(j.changed)) return undefined;
  return j as unknown as GraphChange;
}

/**
 * The proposal a graph tool answered with when asked only to propose.
 *
 * @param output - The tool's result text.
 * @returns The proposal, or undefined.
 */
export function parseProposal(output: string): Proposal | undefined {
  const j = taggedJson(output, TAG_PROPOSAL);
  if (!j || typeof j.path !== "string" || !Array.isArray(j.items)) return undefined;
  return j as unknown as Proposal;
}

/** The refs ("$s") an operation mentions: the node it makes, and the nodes it uses. */
function refsOf(op: BpOp): { makes?: string; uses: string[] } {
  const uses: string[] = [];
  const add = (v: unknown) => typeof v === "string" && v.startsWith("$") && uses.push(v);
  add(op.node);
  for (const k of ["from", "to"]) add((op[k] as { node?: unknown } | undefined)?.node);
  if (Array.isArray(op.nodes)) op.nodes.forEach(add);
  return { ...(typeof op.ref === "string" ? { makes: op.ref } : {}), uses };
}

/**
 * The words for one operation, for the review list.
 *
 * @param op - The operation (applyBpOps' vocabulary); `doc` the graph it applies to; `titles` the titles of the nodes earlier operations make, by ref.
 */
function describe(op: BpOp, doc: BpDoc, graph: string, titles: Map<string, string>): string {
  const nodes = (doc.graphs.find((g) => g.name === graph) ?? doc.graphs[0])?.nodes ?? [];
  const name = (id: unknown) => {
    const s = String(id ?? "");
    return titles.get(s) ?? nodes.find((n) => n.id === s)?.title ?? s;
  };
  const kind = String(op.op ?? "");
  switch (kind) {
    case "add":
      return `+ ${bpNodeTemplate(op, doc).title}`.slice(0, 120);
    case "delete":
      return `− ${name(op.node)}`;
    case "connect": {
      const f = (op.from ?? {}) as { node?: string; pin?: string };
      const t = (op.to ?? {}) as { node?: string; pin?: string };
      return `${name(f.node)}.${f.pin ?? ""} → ${name(t.node)}.${t.pin ?? ""}`;
    }
    case "disconnect":
      return `✂ ${name((op.from as { node?: string } | undefined)?.node ?? op.node)}${op.pin ? `.${String(op.pin)}` : ""}`;
    case "set":
      return `${name(op.node)}.${String(op.pin ?? "")} = ${String(op.value ?? "")}`.slice(0, 120);
    case "move":
      return `↔ ${name(op.node)}`;
    case "comment":
      return (op.node ? `# ${name(op.node)}: ${String(op.text ?? "")}` : `+ # ${String(op.text ?? "Comment")}`).slice(0, 120);
    default:
      return `${kind} ${name(op.node)}`.trim();
  }
}

/**
 * Turns the operations a model wrote into a list the user reviews one change at a time.
 *
 * @param doc - The Blueprint as it is; `graph` the graph the operations apply to; `ops` the operations in order.
 * @returns One item per operation with its words and which earlier items it needs (an operation that uses a node an earlier `add` makes).
 */
export function proposalItems(doc: BpDoc, graph: string, ops: BpOp[]): ProposalItem[] {
  const makers = new Map<string, number>();
  const titles = new Map<string, string>();
  return ops.map((op, i) => {
    const r = refsOf(op);
    const needs = [...new Set(r.uses.map((u) => makers.get(u)).filter((x): x is number => x !== undefined))];
    const label = describe(op, doc, graph, titles);
    if (r.makes) {
      makers.set(r.makes, i);
      titles.set(r.makes, label.replace(/^\+ /, ""));
    }
    return { op, label, needs };
  });
}

/**
 * Accepts or rejects one change of a proposal. Accepting a change also accepts the ones it needs; rejecting one also
 * rejects the ones that need it, so what is left always applies.
 *
 * @param items - The proposal's changes; `accepted` the indexes now accepted; `i` the one the user toggled; `on` whether it is accepted now.
 * @returns The new set of accepted indexes.
 */
export function toggleChange(items: readonly ProposalItem[], accepted: ReadonlySet<number>, i: number, on: boolean): Set<number> {
  const next = new Set(accepted);
  const up = (k: number) => {
    if (next.has(k)) return;
    next.add(k);
    for (const d of items[k]?.needs ?? []) up(d);
  };
  const down = (k: number) => {
    if (!next.delete(k)) return;
    items.forEach((it, j) => it.needs.includes(k) && down(j));
  };
  if (on) up(i);
  else down(i);
  return next;
}

/**
 * The input for the graph write tool from the changes the user accepted: the exact operations, in order. The tool
 * applies them with its own approval; nothing is written from the panel.
 *
 * @param p - The proposal; `accepted` the accepted indexes.
 * @returns The tool's input, or undefined when nothing is accepted.
 */
export function acceptedInput(p: Pick<Proposal, "path" | "graph" | "items">, accepted: ReadonlySet<number>): { path: string; graph: string; ops: BpOp[]; request: string } | undefined {
  const ops = p.items.filter((_, i) => accepted.has(i)).map((it) => it.op);
  return ops.length ? { path: p.path, graph: p.graph, ops, request: `Apply the ${ops.length} accepted change${ops.length === 1 ? "" : "s"}.` } : undefined;
}

/**
 * Checks that a proposal applies to the graph (a dry run), keeping the operations that fail out of the list.
 *
 * @param doc - The Blueprint; `graph` the graph; `ops` the operations.
 * @returns The same operations with, per operation, whether the dry run accepted it.
 */
export function dryRun(doc: BpDoc, graph: string, ops: BpOp[]): boolean[] {
  return applyBpOps(doc, graph, ops).results.map((r) => r.ok);
}

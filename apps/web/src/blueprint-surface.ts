/**
 * Pure helpers of the visual-scripts surface (BlueprintPanel.tsx): which tool results open it, the marks of its diff
 * view, the chat message for "Ask about this node", and the message that sends the accepted changes to the graph write
 * tool. No React, so they run in `node:test`. The graph model itself (summary, proposal, accept/reject) is in
 * `@kesher/shared` (`graph-change.ts`).
 */
import { acceptedInput, changeLabel, parseGraphChange, parseProposal, type GraphChange, type Proposal } from "@kesher/shared";
import type { GNode } from "./BlueprintCanvas";

/** The agent tools whose results open the surface. */
export const BLUEPRINT_TOOLS: readonly string[] = ["unreal_change_graph", "unity_change_graph"];

/** The engine a graph tool belongs to. */
export const engineOf = (tool: string): "unreal" | "unity" => (tool.startsWith("unity") ? "unity" : "unreal");

/** The name shown for an asset path ("/Game/BP/BP_Door.BP_Door" → "BP_Door"). */
export function graphTitle(path: string): string {
  return path.split(/[./\\]/).filter(Boolean).pop() ?? path;
}

/**
 * The item a graph tool step made: the card shows its change, the panel opens on the graph.
 *
 * @param tool - The tool's name; `ok` and `output` its result.
 * @returns The item (id = the asset's path, `data` = the result's text for the card), or undefined for another tool, a failure, or a result with no change or proposal.
 */
export function blueprintFromResult(tool: string, ok: boolean, output: string): { kind: string; id: string; title: string; data: string } | undefined {
  if (!ok || !BLUEPRINT_TOOLS.includes(tool)) return undefined;
  const c = parseGraphChange(output) ?? parseProposal(output);
  return c ? { kind: "blueprint", id: c.path, title: graphTitle(c.path), data: output } : undefined;
}

/** The card's lines for an item's result: the change line, or the number of proposed changes. */
export function cardLine(data: string | undefined, he: boolean): { graph: string; nodes?: number; text: string; proposal: boolean } | undefined {
  if (!data) return undefined;
  const c = parseGraphChange(data);
  if (c) return { graph: c.graph, nodes: c.nodes, text: changeLabel(c, he), proposal: false };
  const p = parseProposal(data);
  if (p) return { graph: p.graph, text: he ? `${p.items.length} שינויים מוצעים` : `${p.items.length} proposed change${p.items.length === 1 ? "" : "s"}`, proposal: true };
  return undefined;
}

/** How a node is marked in the diff view. */
export type Mark = "added" | "changed";

/**
 * The marks of the diff view: which nodes of the graph shown are new or changed.
 *
 * @param c - The change; its graph must be the one shown.
 * @returns Node id → mark. Removed nodes are not in the graph any more; the list under the graph names them.
 */
export function diffMarks(c: Pick<GraphChange, "added" | "changed"> | undefined): Map<string, Mark> {
  const m = new Map<string, Mark>();
  for (const n of c?.changed ?? []) m.set(n.id, "changed");
  for (const n of c?.added ?? []) m.set(n.id, "added");
  return m;
}

/**
 * CSS that draws the marks on the canvas's nodes (the canvas gives each node `data-node`), scoped to the panel.
 *
 * @param scope - A CSS selector of the panel's root.
 * @param marks - The marks.
 */
export function marksCss(scope: string, marks: ReadonlyMap<string, Mark>): string {
  const esc = (id: string) => id.replace(/["\\]/g, "\\$&");
  const rule = (kind: Mark, color: string) => {
    const sel = [...marks].filter(([, k]) => k === kind).map(([id]) => `${scope} [data-node="${esc(id)}"]`);
    return sel.length ? `${sel.join(",")}{filter:drop-shadow(0 0 5px ${color}) drop-shadow(0 0 2px ${color})}` : "";
  };
  return rule("added", "#3ecf6e") + rule("changed", "#f0b429");
}

/** The pins of a node as a short line ("in Exec(exec), out Then(exec)→2 links"), at most `max` pins. */
export function pinSummary(n: Pick<GNode, "pins">, max = 16): string {
  const pins = n.pins.slice(0, max).map((p) => `${p.dir} ${p.label || p.name}(${p.type})${p.default ? `=${p.default}` : ""}${p.links?.length ? `→${p.links.length}` : ""}`);
  return pins.join(", ") + (n.pins.length > max ? `, +${n.pins.length - max}` : "");
}

/**
 * The chat message for a node picked in the graph: its title, class and pins, and the question.
 *
 * @param p - The asset's `path` and `graph`, the `node`, the user's `instruction`, and `he`.
 */
export function askNodeMessage(p: { path: string; graph: string; node: Pick<GNode, "id" | "title" | "class" | "pins" | "comment">; instruction: string; he: boolean }): string {
  const n = p.node;
  const head = p.he ? `ב-Blueprint ${graphTitle(p.path)} (${p.path}), בגרף ${p.graph}, על הנוד הזה:` : `In ${graphTitle(p.path)} (${p.path}), graph ${p.graph}, about this node:`;
  const body = `"${n.title}" · ${n.class} · id ${n.id}\n${p.he ? "פינים" : "Pins"}: ${pinSummary(n) || "-"}${n.comment ? `\n${p.he ? "הערה" : "Comment"}: ${n.comment}` : ""}`;
  return `${head}\n${body}\n\n${p.instruction.trim()}`;
}

/**
 * The chat message that sends the accepted changes to the graph write tool. The agent calls the tool with exactly this
 * input, so the tool's approval card appears; the panel writes nothing itself.
 *
 * @param tool - The write tool (`unreal_change_graph` / `unity_change_graph`).
 * @param p - The proposal; `accepted` the accepted indexes; `he` the language.
 * @returns The message, or undefined when nothing is accepted.
 */
export function acceptMessage(tool: string, p: Pick<Proposal, "path" | "graph" | "items">, accepted: ReadonlySet<number>, he: boolean): string | undefined {
  const input = acceptedInput(p, accepted);
  if (!input) return undefined;
  const lead = he ? `אני מאשר ${input.ops.length} מהשינויים שהצעת ב-${graphTitle(p.path)}. הפעל את ${tool} עם הקלט הזה בדיוק, בלי לשנות אותו:` : `I accept ${input.ops.length} of the changes you proposed in ${graphTitle(p.path)}. Call ${tool} with exactly this input, unchanged:`;
  return `${lead}\n${JSON.stringify(input)}`;
}

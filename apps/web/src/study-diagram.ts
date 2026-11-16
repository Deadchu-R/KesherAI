/**
 * A small reader for the Mermaid flowcharts the study summaries ask the model for ("flowchart LR", `A[label] --> B`),
 * so a lecture's diagram shows as boxes and arrows without a diagram library. Anything it cannot read is shown as
 * text by the page.
 */

/** A flowchart: its boxes in reading order and the arrows between them. */
export interface Flow {
  dir: "LR" | "TD";
  nodes: Array<{ id: string; label: string }>;
  edges: Array<{ from: string; to: string; label?: string }>;
}

const NODE = /^([A-Za-z0-9_]+)\s*(?:\[\(?"?([^\]"]*)"?\)?\]|\(\(?"?([^)"]*)"?\)?\)|\{"?([^}"]*)"?\})?$/;

/**
 * Reads a Mermaid flowchart.
 *
 * @param src - The diagram's source.
 * @returns The flowchart, or undefined when it is not one this reader understands.
 */
export function parseFlow(src: string): Flow | undefined {
  const lines = src.split(/\n|;/).map((l) => l.trim()).filter((l) => l && !l.startsWith("%%"));
  const head = /^(?:flowchart|graph)\s+(LR|RL|TD|TB|BT)?/i.exec(lines[0] ?? "");
  if (!head) return undefined;
  const flow: Flow = { dir: /LR|RL/i.test(head[1] ?? "") ? "LR" : "TD", nodes: [], edges: [] };
  const seen = new Map<string, { id: string; label: string }>();
  const node = (raw: string) => {
    const m = NODE.exec(raw.trim());
    if (!m) return undefined;
    const id = m[1]!;
    const label = (m[2] ?? m[3] ?? m[4] ?? "").trim();
    let n = seen.get(id);
    if (!n) {
      n = { id, label: label || id };
      seen.set(id, n);
      flow.nodes.push(n);
    } else if (label) n.label = label;
    return n;
  };
  for (const line of lines.slice(1)) {
    if (/^(style|classDef|class|linkStyle|subgraph|end)\b/.test(line)) continue;
    const parts = line.split(/\s*(?:-->|==>|-\.->|---)\s*(?:\|([^|]*)\|\s*)?/);
    // split keeps the |labels| at odd positions
    const items: string[] = [];
    const labels: Array<string | undefined> = [];
    for (let i = 0; i < parts.length; i++) (i % 2 === 0 ? items : labels).push(parts[i]);
    let prev: { id: string } | undefined;
    for (const [i, it] of items.entries()) {
      if (it === undefined || !it.trim()) return undefined;
      const n = node(it);
      if (!n) return undefined;
      if (prev) flow.edges.push({ from: prev.id, to: n.id, ...(labels[i - 1]?.trim() ? { label: labels[i - 1]!.trim() } : {}) });
      prev = n;
    }
  }
  return flow.nodes.length ? flow : undefined;
}

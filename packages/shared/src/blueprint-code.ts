/**
 * A Blueprint graph written as code: each event (or function entry) becomes
 * a block, each executed node a line in the order the white exec wires run
 * them, and the values flowing in on data wires become the call's arguments
 * (pure nodes like Get or + become nested expressions). Every line knows its
 * node, so the page can show the two side by side and point from one to the
 * other.
 *
 * How others do it (researched first): Unreal itself has no text view, but
 * the community "Blueprint to C++" / BP2Text tools and AI assistants write a
 * graph as pseudo-code by following the exec wires from each event; Unity
 * Visual Scripting's "Generate C#" does the same from its units.
 */

/** A pin as the editor bridges send it. */
export interface CodePin { name: string; label?: string; dir: "in" | "out"; type: string; default?: string; links?: string[] }
/** A node as the editor bridges send it. */
export interface CodeNode { id: string; title: string; class: string; x: number; y: number; comment?: string; pins: CodePin[] }
/** One line of the code and the node it came from. */
export interface CodeLine { text: string; node?: string; depth: number }

const ident = (s: string) => s.split("\n")[0]!.replace(/^Event\s+/, "").replace(/[^\w]+/g, "") || "Node";
const isExec = (p: CodePin) => p.type === "exec";
/** An event's "Output Delegate" pin (for binding it elsewhere): not a value the code uses. */
const isDelegate = (p: CodePin) => /^delegate/i.test(p.type) || /OutputDelegate/.test(p.name);
const label = (p: CodePin) => (p.label ?? p.name).replace(/\s+/g, "");
const literal = (v: string, type: string) => (/^(string|text|name)/i.test(type) ? JSON.stringify(v) : v);

/**
 * @param nodes - One graph's nodes.
 * @returns The lines, each with its node (headers and the "not connected" part too).
 */
export function blueprintToCode(nodes: CodeNode[]): CodeLine[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  // Which output feeds each input ("node:pin" of the source), from the outputs' link lists.
  const source = new Map<string, string>();
  for (const n of nodes) for (const p of n.pins) if (p.dir === "out") for (const l of p.links ?? []) source.set(l, `${n.id}:${p.name}`);
  const hasExecIn = (n: CodeNode) => n.pins.some((p) => isExec(p) && p.dir === "in");
  const pure = (n: CodeNode) => !n.pins.some(isExec);
  const out: CodeLine[] = [];
  const done = new Set<string>();

  const expr = (src: string, depth = 0): string => {
    const [id, pin] = [src.slice(0, src.lastIndexOf(":")), src.slice(src.lastIndexOf(":") + 1)];
    const n = byId.get(id);
    if (!n) return "?";
    const p = n.pins.find((x) => x.name === pin);
    if (!pure(n) || depth > 6) {
      // An event's or an executed node's output: read by name.
      return hasExecIn(n) ? `${ident(n.title)}.${p ? label(p) : pin}` : p ? label(p) : pin;
    }
    const dataOuts = n.pins.filter((x) => x.dir === "out" && !isExec(x));
    const call = `${ident(n.title)}(${args(n, depth + 1)})`;
    return dataOuts.length > 1 && p ? `${call}.${label(p)}` : call;
  };
  const args = (n: CodeNode, depth = 0) =>
    n.pins
      .filter((p) => p.dir === "in" && !isExec(p) && !isDelegate(p))
      .map((p) => {
        const s = source.get(`${n.id}:${p.name}`);
        if (s) return `${label(p)}=${expr(s, depth)}`;
        if (p.default !== undefined && p.default !== "" && !/^(None|false|0(\.0+)?)$/.test(p.default)) return `${label(p)}=${literal(p.default, p.type)}`;
        return "";
      })
      .filter(Boolean)
      .join(", ");

  const walk = (id: string, depth: number) => {
    for (let cur: string | undefined = id, guard = 0; cur && guard < 500; guard++) {
      const n = byId.get(cur);
      if (!n) return;
      if (done.has(n.id)) {
        out.push({ text: `→ ${ident(n.title)}`, node: n.id, depth });
        return;
      }
      done.add(n.id);
      const results = n.pins.filter((p) => p.dir === "out" && !isExec(p) && !isDelegate(p) && p.links?.length).map(label);
      out.push({ text: `${results.length ? `${results.join(", ")} = ` : ""}${ident(n.title)}(${args(n)})${n.comment ? `  // ${n.comment.split("\n")[0]}` : ""}`, node: n.id, depth });
      const execOuts = n.pins.filter((p) => p.dir === "out" && isExec(p));
      const next = (p: CodePin) => p.links?.[0]?.slice(0, p.links[0].lastIndexOf(":"));
      if (execOuts.length <= 1) {
        cur = execOuts[0] ? next(execOuts[0]) : undefined;
        continue;
      }
      // Branch (then / else), Sequence (then 0, then 1…), loops: one block per wired output.
      for (const p of execOuts) {
        const to = next(p);
        if (!to) continue;
        out.push({ text: `${label(p)}:`, node: n.id, depth: depth + 1 });
        walk(to, depth + 2);
      }
      return;
    }
  };

  // Entries: nodes with exec outputs and no exec input (events, custom events, function entries), top to bottom.
  const entries = nodes.filter((n) => !hasExecIn(n) && n.pins.some((p) => isExec(p) && p.dir === "out")).sort((a, b) => a.y - b.y || a.x - b.x);
  for (const e of entries) {
    done.add(e.id);
    const params = e.pins.filter((p) => p.dir === "out" && !isExec(p) && !isDelegate(p)).map(label);
    out.push({ text: `on ${ident(e.title)}(${params.join(", ")}):${e.comment ? `  // ${e.comment.split("\n")[0]}` : ""}`, node: e.id, depth: 0 });
    const first = e.pins.find((p) => isExec(p) && p.dir === "out" && p.links?.length);
    const to = first?.links?.[0];
    if (to) walk(to.slice(0, to.lastIndexOf(":")), 1);
    else out.push({ text: "pass", depth: 1 });
    out.push({ text: "", depth: 0 });
  }
  // Executed nodes no event reaches: listed, so nothing in the graph is hidden.
  const loose = nodes.filter((n) => !done.has(n.id) && hasExecIn(n)).sort((a, b) => a.y - b.y || a.x - b.x);
  if (loose.length) {
    out.push({ text: "// not connected to an event:", depth: 0 });
    for (const n of loose) if (!done.has(n.id)) walk(n.id, 1);
  }
  while (out.length && !out.at(-1)!.text) out.pop();
  return out;
}

/** The lines as one text (4 spaces per level). */
export function codeText(lines: CodeLine[]): string {
  return lines.map((l) => `${"    ".repeat(l.depth)}${l.text}`).join("\n");
}

/**
 * A first look at the same graph in Verse, Unreal 6's gameplay language
 * (UEFN today): each event becomes a method of a `creative_device` class,
 * Print String → Print, Delay → Sleep (so the method gets <suspends>),
 * Branch → if/else, Set → set. Nodes with no clear Verse match stay as a
 * call with a "# check" note: it is a starting point to read and port, not
 * a checked translation (researched first: NodeToCode turns Blueprints into
 * C++ with a model; Epic promises Blueprint→Verse conversion tools for UE6).
 *
 * @param nodes - One graph's nodes.
 * @param className - The Blueprint's name (the class is named after it).
 */
export function blueprintToVerse(nodes: CodeNode[], className = "my"): CodeLine[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const source = new Map<string, string>();
  for (const n of nodes) for (const p of n.pins) if (p.dir === "out") for (const l of p.links ?? []) source.set(l, `${n.id}:${p.name}`);
  const hasExecIn = (n: CodeNode) => n.pins.some((p) => isExec(p) && p.dir === "in");
  const pure = (n: CodeNode) => !n.pins.some(isExec);
  const verseName = (s: string) => ident(s).replace(/^K2_/, "");
  const vLit = (v: string, type: string) => (/^(string|text|name)/i.test(type) ? JSON.stringify(v) : /^bool/i.test(type) ? (v === "true" ? "true" : "false") : v);
  const expr = (src: string, depth = 0): string => {
    const [id, pin] = [src.slice(0, src.lastIndexOf(":")), src.slice(src.lastIndexOf(":") + 1)];
    const n = byId.get(id);
    if (!n) return "?";
    const p = n.pins.find((x) => x.name === pin);
    const title = n.title.split("\n")[0]!;
    if (/^Get\s+/.test(title)) return verseName(title.replace(/^Get\s+/, ""));
    if (!pure(n) || depth > 6) return p ? label(p) : pin;
    const a = values(n, depth + 1);
    // Simple math and comparison nodes read as operators.
    const ops: Record<string, string> = { Add: "+", Subtract: "-", Multiply: "*", Divide: "/", Greater: ">", Less: "<", GreaterEqual: ">=", LessEqual: "<=", EqualEqual: "=", NotEqual: "<>" };
    const op = Object.entries(ops).find(([k]) => new RegExp(`^${k}|[_ ]${k}`, "i").test(ident(title)))?.[1];
    if (op && a.length === 2) return `(${a[0]} ${op} ${a[1]})`;
    return `${verseName(title)}(${a.join(", ")})`;
  };
  const values = (n: CodeNode, depth = 0) =>
    n.pins
      .filter((p) => p.dir === "in" && !isExec(p) && !isDelegate(p) && !/^(self|Target|WorldContextObject)$/i.test(p.name))
      .map((p) => {
        const s = source.get(`${n.id}:${p.name}`);
        if (s) return expr(s, depth);
        if (p.default !== undefined && p.default !== "" && !/^(None|\(.*\))$/.test(p.default)) return vLit(p.default, p.type);
        return "";
      })
      .filter(Boolean);
  const pin = (n: CodeNode, name: RegExp) => {
    const p = n.pins.find((x) => x.dir === "in" && name.test(x.name));
    if (!p) return "";
    const s = source.get(`${n.id}:${p.name}`);
    return s ? expr(s) : p.default !== undefined ? vLit(p.default, p.type) : "";
  };
  const out: CodeLine[] = [];
  const done = new Set<string>();
  let suspends = false;

  const line = (n: CodeNode): string => {
    const t = ident(n.title);
    if (/^PrintString$|^PrintText$/.test(t)) return `Print(${pin(n, /^In(String|Text)$/) || '""'})`;
    if (/^Delay$/.test(t)) {
      suspends = true;
      return `Sleep(${pin(n, /^Duration$/) || "0.0"})`;
    }
    if (/^Set/.test(t) && n.class.includes("VariableSet")) return `set ${verseName(n.title.replace(/^Set\s+/, ""))} = ${values(n)[0] ?? "?"}`;
    if (/^DestroyActor$/.test(t)) return "# check: Verse has no DestroyActor; hide or dispose the prop (e.g. Prop.Dispose())";
    return `${verseName(n.title)}(${values(n).join(", ")})  # check: the Verse API for this node`;
  };
  const walk = (id: string, depth: number) => {
    for (let cur: string | undefined = id, guard = 0; cur && guard < 500; guard++) {
      const n = byId.get(cur);
      if (!n) return;
      if (done.has(n.id)) {
        out.push({ text: `# continues at ${ident(n.title)} (above)`, node: n.id, depth });
        return;
      }
      done.add(n.id);
      const execOuts = n.pins.filter((p) => p.dir === "out" && isExec(p));
      const next = (p: CodePin) => p.links?.[0]?.slice(0, p.links[0].lastIndexOf(":"));
      if (n.class.includes("IfThenElse") || ident(n.title) === "Branch") {
        const thenP = execOuts.find((p) => /then|true/i.test(p.name));
        const elseP = execOuts.find((p) => /else|false/i.test(p.name));
        out.push({ text: `if (${pin(n, /^Condition$/) || "true"}?):`, node: n.id, depth });
        const t = thenP && next(thenP);
        if (t) walk(t, depth + 1);
        else out.push({ text: "block {}", depth: depth + 1 });
        const e = elseP && next(elseP);
        if (e) {
          out.push({ text: "else:", node: n.id, depth });
          walk(e, depth + 1);
        }
        return;
      }
      out.push({ text: `${line(n)}${n.comment ? `  # ${n.comment.split("\n")[0]}` : ""}`, node: n.id, depth });
      if (execOuts.length <= 1) {
        cur = execOuts[0] ? next(execOuts[0]) : undefined;
        continue;
      }
      // Sequence and other multi-output nodes: each output's chain in turn.
      for (const p of execOuts) {
        const to = next(p);
        if (to) walk(to, depth);
      }
      return;
    }
  };

  const cls = `${className.replace(/^BP_|^WBP_/, "").replace(/[^\w]/g, "") || "my"}_device`;
  out.push({ text: "using { /Fortnite.com/Devices }", depth: 0 });
  out.push({ text: "using { /Verse.org/Simulation }", depth: 0 });
  out.push({ text: "", depth: 0 });
  out.push({ text: `${cls} := class(creative_device):`, depth: 0 });
  const entries = nodes.filter((n) => !hasExecIn(n) && n.pins.some((p) => isExec(p) && p.dir === "out")).sort((a, b) => a.y - b.y || a.x - b.x);
  for (const e of entries) {
    done.add(e.id);
    const ev = ident(e.title);
    const params = e.pins.filter((p) => p.dir === "out" && !isExec(p) && !isDelegate(p));
    const start = out.length;
    out.push({ text: "", node: e.id, depth: 1 });
    const first = e.pins.find((p) => isExec(p) && p.dir === "out" && p.links?.length);
    const to = first?.links?.[0];
    suspends = false;
    if (to) walk(to.slice(0, to.lastIndexOf(":")), 2);
    else out.push({ text: "block {}", depth: 2 });
    const head =
      /^BeginPlay$/.test(ev) ? `OnBegin<override>()<suspends>:void=`
      : /^Tick$/.test(ev) ? `# Tick: Verse has no per-frame event; loop in OnBegin with Sleep(0.0)\n    OnTick(DeltaSeconds:float)${suspends ? "<suspends>" : ""}:void=`
      : /Overlap/.test(ev) ? `# Overlap: subscribe in OnBegin, e.g. Trigger.TriggeredEvent.Subscribe(On${ev})\n    On${ev}(Agent:?agent)${suspends ? "<suspends>" : ""}:void=`
      : `${ev}(${params.map((p) => `${label(p)}:${/float|real|double/i.test(p.type) ? "float" : /int/i.test(p.type) ? "int" : /bool/i.test(p.type) ? "logic" : "any"}`).join(", ")})${suspends ? "<suspends>" : ""}:void=`;
    out[start] = { text: head, node: e.id, depth: 1 };
    out.push({ text: "", depth: 0 });
  }
  const loose = nodes.filter((n) => !done.has(n.id) && hasExecIn(n)).sort((a, b) => a.y - b.y || a.x - b.x);
  if (loose.length) {
    out.push({ text: "# not connected to an event:", depth: 1 });
    for (const n of loose) if (!done.has(n.id)) walk(n.id, 1);
  }
  while (out.length && !out.at(-1)!.text) out.pop();
  return out;
}

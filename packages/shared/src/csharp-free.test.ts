import { test } from "node:test";
import assert from "node:assert/strict";
import { methodToNodes, parseCSharp, writeCSharp, type CsLayout, type CsStmt } from "./csharp-graph.js";
import { breakExec, deleteStep, detachFrom, placeAlone, wireExec } from "./csharp-free.js";

const SCRIPT = `using UnityEngine;

public class Door : MonoBehaviour
{
    public float speed = 2f;

    void Start()
    {
        Debug.Log("A");
        Debug.Log("B");
        Debug.Log("C");
    }
}
`;

const log = (text: string): CsStmt => ({ id: "x", kind: "call", target: "Debug", name: "Log", args: [`"${text}"`], src: "", dirty: true });

test("free graph: a node alone is kept on the graph, not in the code", () => {
  const classes = parseCSharp(SCRIPT);
  const m = classes[0]!.methods[0]!;
  const layout: CsLayout = {};
  const id = placeAlone(m, layout, log("Alone"), 600, 400);
  const out = writeCSharp(SCRIPT, classes);
  assert.ok(!out.includes('"Alone"'), "not in the code");
  const nodes = methodToNodes(m, layout);
  const n = nodes.find((x) => x.id === id)!;
  assert.equal(n.detached, true);
  assert.deepEqual([n.x, n.y], [600, 400]);
  assert.ok(!nodes[0]!.pins[0]!.links!.includes(`${id}:execute`), "the entry does not wire to it");
});

test("free graph: wiring an exec pin puts the node in the code there; what followed is cut loose", () => {
  const classes = parseCSharp(SCRIPT);
  const m = classes[0]!.methods[0]!;
  const layout: CsLayout = {};
  const alone = placeAlone(m, layout, log("New"), 0, 0);
  const a = m.body[0]!.id;
  assert.equal(wireExec(m, layout, { node: a, pin: "then" }, alone, { x: 100, y: 300 }), undefined);
  const out = writeCSharp(SCRIPT, classes);
  assert.ok(/"A"\);\s*Debug\.Log\("New"\);\s*\}/.test(out), out);
  assert.ok(!out.includes('"B"') && !out.includes('"C"'), "B and C were cut loose (one wire per exec output)");
  const loose = layout.detached![m.name]!;
  assert.equal(loose.length, 1);
  assert.deepEqual(loose[0]!.stmts.map((s) => (s.kind === "call" ? s.args[0] : "")), ['"B"', '"C"']);
  // Wire them back after New: all four in order.
  const newId = m.body[1]!.id;
  assert.equal(wireExec(m, layout, { node: newId, pin: "then" }, loose[0]!.stmts[0]!.id, { x: 0, y: 0 }), undefined);
  const again = writeCSharp(SCRIPT, classes);
  assert.ok(/"A"\);\s*Debug\.Log\("New"\);\s*Debug\.Log\("B"\);\s*Debug\.Log\("C"\);/.test(again), again);
  assert.equal(layout.detached![m.name]!.length, 0);
});

test("free graph: breaking an exec wire takes the steps out of the code; delete works anywhere; no cycles", () => {
  const classes = parseCSharp(SCRIPT);
  const m = classes[0]!.methods[0]!;
  const layout: CsLayout = {};
  const b = m.body[1]!.id;
  assert.ok(breakExec(m, layout, b, "execute", "in", { x: 50, y: 50 }));
  let out = writeCSharp(SCRIPT, classes);
  assert.ok(out.includes('"A"') && !out.includes('"B"') && !out.includes('"C"'));
  const chain = layout.detached![m.name]![0]!;
  assert.equal(chain.stmts.length, 2);
  assert.ok(deleteStep(m, layout, chain.stmts[1]!.id));
  assert.equal(chain.stmts.length, 1);
  // Entry → the loose B: B goes first, A is cut loose.
  assert.equal(wireExec(m, layout, { node: m.id, pin: "then" }, chain.stmts[0]!.id, { x: 0, y: 0 }), undefined);
  out = writeCSharp(SCRIPT, classes);
  assert.ok(out.includes('"B"') && !out.includes('"A"'));
  const loose = layout.detached![m.name]![0]!;
  // A cycle: wiring B's then into... B itself is refused.
  assert.ok(wireExec(m, layout, { node: m.body[0]!.id, pin: "then" }, m.body[0]!.id, { x: 0, y: 0 }));
  assert.ok(detachFrom(m, layout, loose.stmts[0]!.id, 9, 9));
});

test("reroute nodes: split a wire, chain, follow back to the real pins, and run straight when removed", async () => {
  const { withKnots, realPin, addKnot, removeKnot } = await import("./csharp-free.js");
  const nodes = [
    { id: "a", title: "A", class: "", x: 0, y: 0, pins: [{ name: "then", dir: "out" as const, type: "exec", links: ["b:execute"] }] },
    { id: "b", title: "B", class: "", x: 300, y: 0, pins: [{ name: "execute", dir: "in" as const, type: "exec", links: ["a:then"] }] },
  ];
  const layout: import("./csharp-graph.js").CsLayout = {};
  const k1 = addKnot(layout, "Update", "a:then", "b:execute", 100, 50);
  const k2 = addKnot(layout, "Update", `${k1}:OutputPin`, "b:execute", 200, 50);
  const { nodes: drawn, live } = withKnots(nodes, layout.knots!.Update!);
  assert.equal(live.length, 2);
  assert.deepEqual(drawn.find((n) => n.id === "a")!.pins[0]!.links, [`${k1}:InputPin`]);
  assert.deepEqual(drawn.find((n) => n.id === k1)!.pins[1]!.links, [`${k2}:InputPin`]);
  assert.deepEqual(drawn.find((n) => n.id === k2)!.pins[1]!.links, ["b:execute"]);
  assert.equal(drawn.find((n) => n.id === k2)!.class, "K2Node_Knot");
  assert.deepEqual(nodes[0]!.pins[0]!.links, ["b:execute"], "the parsed nodes are not changed");
  assert.equal(realPin(layout.knots!.Update!, `${k2}:OutputPin`), "a:then");
  assert.equal(realPin(layout.knots!.Update!, `${k1}:InputPin`), "b:execute");
  // Removing the first: the second now starts at A.
  assert.ok(removeKnot(layout, "Update", k1));
  assert.deepEqual(layout.knots!.Update!.map((k) => k.from), ["a:then"]);
  // A wire that is gone takes its reroute nodes with it.
  assert.equal(withKnots([{ ...nodes[0]!, pins: [{ ...nodes[0]!.pins[0]!, links: [] }] }, nodes[1]!], layout.knots!.Update!).live.length, 0);
});

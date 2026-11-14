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

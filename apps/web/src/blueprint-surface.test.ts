import assert from "node:assert/strict";
import test from "node:test";
import { changeLine, proposalItems, summarizeChange, type BpDoc } from "@kesher/shared";
import { acceptMessage, askNodeMessage, blueprintFromResult, cardLine, diffMarks, engineOf, graphTitle, marksCss, pinSummary } from "./blueprint-surface.js";

const doc: BpDoc = { path: "/Game/BP_Door.BP_Door", name: "BP_Door", variables: [], graphs: [{ name: "EventGraph", kind: "event", nodes: [{ id: "a", title: "Event BeginPlay", class: "K2Node_Event", x: 0, y: 0, pins: [{ name: "then", dir: "out", type: "exec" }] }] }] };
const after: BpDoc = { ...doc, graphs: [{ ...doc.graphs[0]!, nodes: [...doc.graphs[0]!.nodes, { id: "b", title: "Print String", class: "K2Node_CallFunction", x: 200, y: 0, pins: [{ name: "execute", dir: "in", type: "exec" }] }] }] };
const change = summarizeChange(doc, after, "EventGraph");
const output = `Done.\n${changeLine(change)}`;

test("blueprintFromResult: the write tools' results open the surface, other tools and failures do not", () => {
  assert.deepEqual(blueprintFromResult("unreal_change_graph", true, output), { kind: "blueprint", id: doc.path, title: "BP_Door", data: output });
  assert.equal(blueprintFromResult("unity_change_graph", true, output)?.id, doc.path);
  assert.equal(blueprintFromResult("unreal_change_graph", false, output), undefined);
  assert.equal(blueprintFromResult("unreal_change_graph", true, "Applied 1/1 operations."), undefined);
  assert.equal(blueprintFromResult("unreal_read_graph", true, output), undefined);
  assert.equal(engineOf("unity_change_graph"), "unity");
  assert.equal(graphTitle("/Game/BP/BP_Door.BP_Door"), "BP_Door");
});

test("cardLine: the card shows the graph, node count and what changed, in both languages", () => {
  assert.deepEqual(cardLine(output, false), { graph: "EventGraph", nodes: 2, text: "+1 node", proposal: false });
  assert.match(cardLine(output, true)!.text, /נוד/);
  const p = { path: doc.path, graph: "EventGraph", kind: "unreal" as const, note: "", items: proposalItems(doc, "EventGraph", [{ op: "delete", node: "a" }]) };
  assert.equal(cardLine(`[graph-proposal] ${JSON.stringify(p)}`, false)?.text, "1 proposed change");
  assert.equal(cardLine(undefined, false), undefined);
});

test("diff marks: added and changed nodes get CSS; the panel's scope is kept and ids are escaped", () => {
  const m = diffMarks({ added: [{ id: "b", title: "", class: "" }], changed: [{ id: 'a"x', title: "", class: "" }] });
  assert.equal(m.get("b"), "added");
  const css = marksCss("[data-bp-sf]", m);
  assert.match(css, /\[data-bp-sf\] \[data-node="b"\]\{filter:drop-shadow\(0 0 5px #3ecf6e\)/);
  assert.match(css, /data-node="a\\"x"/);
  assert.equal(marksCss("x", new Map()), "");
});

test("askNodeMessage: node title, class, id and pins go into the chat", () => {
  const node = { id: "b", title: "Print String", class: "K2Node_CallFunction", pins: [{ name: "execute", dir: "in" as const, type: "exec", links: ["a"] }, { name: "InString", dir: "in" as const, type: "string", default: "Hello" }] };
  assert.equal(pinSummary(node), "in execute(exec)→1, in InString(string)=Hello");
  const en = askNodeMessage({ path: doc.path, graph: "EventGraph", node, instruction: " why? ", he: false });
  assert.match(en, /"Print String" · K2Node_CallFunction · id b/);
  assert.match(en, /Pins: in execute\(exec\)→1/);
  assert.ok(en.endsWith("why?"));
  assert.match(askNodeMessage({ path: doc.path, graph: "EventGraph", node, instruction: "למה?", he: true }), /^ב-Blueprint BP_Door/);
});

test("acceptMessage: the accepted changes become one call of the write tool with the exact ops", () => {
  const ops = [{ op: "add", ref: "$p", type: "call", function: "KismetSystemLibrary:PrintString" }, { op: "connect", from: { node: "a", pin: "then" }, to: { node: "$p", pin: "execute" } }];
  const p = { path: doc.path, graph: "EventGraph", items: proposalItems(doc, "EventGraph", ops) };
  assert.equal(acceptMessage("unreal_change_graph", p, new Set(), false), undefined);
  const text = acceptMessage("unreal_change_graph", p, new Set([0, 1]), false)!;
  assert.match(text, /Call unreal_change_graph with exactly this input/);
  const json = JSON.parse(text.slice(text.indexOf("\n") + 1)) as { ops: unknown[]; path: string };
  assert.deepEqual(json.ops, ops);
  assert.equal(json.path, doc.path);
});

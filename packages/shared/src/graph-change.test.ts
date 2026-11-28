import assert from "node:assert/strict";
import test from "node:test";
import { acceptedInput, applyBpOps, changeLabel, changeLine, parseGraphChange, parseProposal, proposalItems, summarizeChange, toggleChange, type BpDoc } from "./index.js";

const doc: BpDoc = {
  path: "/Game/BP_Door.BP_Door",
  name: "BP_Door",
  variables: [],
  graphs: [{
    name: "EventGraph",
    kind: "event",
    nodes: [
      { id: "ev", title: "Event BeginPlay", class: "K2Node_Event", x: 0, y: 0, pins: [{ name: "then", dir: "out", type: "exec" }] },
      { id: "old", title: "Delay", class: "K2Node_CallFunction", x: 300, y: 0, pins: [{ name: "execute", dir: "in", type: "exec" }] },
    ],
  }],
};
const ops = [
  { op: "add", ref: "$p", type: "call", function: "KismetSystemLibrary:PrintString", x: 300, y: 100 },
  { op: "connect", from: { node: "ev", pin: "then" }, to: { node: "$p", pin: "execute" } },
  { op: "delete", node: "old" },
];

test("summarizeChange: nodes added, removed and changed, links made, and the card's words", () => {
  const after = applyBpOps(doc, "EventGraph", ops, { newId: (n) => `n${n}` }).doc;
  const c = summarizeChange(doc, after, "EventGraph");
  assert.equal(c.added.length, 1);
  assert.deepEqual(c.removed.map((n) => n.id), ["old"]);
  assert.deepEqual(c.changed.map((n) => n.id), ["ev"]);
  assert.equal(c.links, 1);
  assert.equal(c.nodes, 2);
  assert.equal(changeLabel(c, false), "+1 node, -1 node, +1 link, 1 changed");
  assert.match(changeLabel(c, true), /^\+נוד/);
  assert.equal(changeLabel({ added: [], removed: [], changed: [], links: 0, unlinked: 0 }, false), "no change");
});

test("the result line round-trips and bad lines are ignored", () => {
  const c = summarizeChange(doc, doc, "EventGraph");
  assert.deepEqual(parseGraphChange(`Applied 1/1.\n${changeLine(c)}`), c);
  assert.equal(parseGraphChange("Applied 1/1."), undefined);
  assert.equal(parseGraphChange("[graph-change] {not json"), undefined);
  assert.equal(parseProposal("[graph-proposal] []"), undefined);
});

test("proposalItems: words per operation and which earlier change each one needs", () => {
  const items = proposalItems(doc, "EventGraph", ops);
  assert.equal(items.length, 3);
  assert.match(items[0]!.label, /^\+ /);
  assert.deepEqual(items[1]!.needs, [0]);
  assert.match(items[1]!.label, /Event BeginPlay\.then → .*\.execute/);
  assert.equal(items[2]!.label, "− Delay");
});

test("toggleChange: accepting pulls in what it needs, rejecting drops what depends on it", () => {
  const items = proposalItems(doc, "EventGraph", ops);
  const all = new Set([0, 1, 2]);
  assert.deepEqual([...toggleChange(items, all, 0, false)].sort(), [2]);
  assert.deepEqual([...toggleChange(items, new Set(), 1, true)].sort(), [0, 1]);
  assert.deepEqual([...toggleChange(items, all, 2, false)].sort(), [0, 1]);
});

test("acceptedInput: the accepted operations in order, as the write tool's input; none accepted gives nothing", () => {
  const p = { path: doc.path, graph: "EventGraph", items: proposalItems(doc, "EventGraph", ops) };
  const input = acceptedInput(p, new Set([0, 1]))!;
  assert.deepEqual(input.ops, [ops[0], ops[1]]);
  assert.equal(input.path, doc.path);
  assert.equal(acceptedInput(p, new Set()), undefined);
});

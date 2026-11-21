import { test } from "node:test";
import assert from "node:assert/strict";
import { applyBpOps, bpNodeKind, canConnectBp, COMMON_BP_ACTIONS, diffBpGraphs, isChildClass, isPureNode, mapCompileMessages, parseBpDoc, searchBpActions, serializeBpDoc, unrealPinsFit, type BpDoc } from "./unreal-bp.js";

/** A Blueprint as the KesherAI Bridge plugin answers `graph`: BeginPlay → Branch → Print String, a getter, a function. */
function fixture(): BpDoc {
  return {
    path: "/Game/BP_Door.BP_Door",
    name: "BP_Door",
    parent: "Actor",
    variables: [
      { name: "Health", type: "real", ptype: "real", default: "100" },
      { name: "IsOpen", type: "bool", ptype: "bool", default: "false" },
      { name: "Targets", type: "object:Actor", ptype: "object:Actor[]" },
    ],
    graphs: [
      {
        name: "EventGraph",
        kind: "event",
        nodes: [
          { id: "E1", title: "Event BeginPlay", class: "K2Node_Event", x: 0, y: 0, pins: [{ name: "then", dir: "out", type: "exec", links: ["B1:execute"] }] },
          {
            id: "B1", title: "Branch", class: "K2Node_IfThenElse", x: 300, y: 0,
            pins: [
              { name: "execute", dir: "in", type: "exec", links: ["E1:then"] },
              { name: "Condition", dir: "in", type: "bool", links: ["G1:IsOpen"] },
              { name: "then", label: "True", dir: "out", type: "exec", links: ["P1:execute"] },
              { name: "else", label: "False", dir: "out", type: "exec" },
            ],
          },
          { id: "G1", title: "IsOpen", class: "K2Node_VariableGet", variable: "IsOpen", x: 100, y: 150, pins: [{ name: "IsOpen", dir: "out", type: "bool", links: ["B1:Condition"] }] },
          {
            id: "P1", title: "Print String", class: "K2Node_CallFunction", function: "KismetSystemLibrary:PrintString", x: 600, y: 0,
            pins: [
              { name: "execute", dir: "in", type: "exec", links: ["B1:then"] },
              { name: "then", dir: "out", type: "exec" },
              { name: "InString", label: "In String", dir: "in", type: "string", default: "Open" },
            ],
          },
        ],
      },
      { name: "Open", kind: "function", nodes: [{ id: "F1", title: "Open", class: "K2Node_FunctionEntry", x: 0, y: 0, pins: [{ name: "then", dir: "out", type: "exec" }] }] },
    ],
  };
}

const tab = (d: BpDoc, name = "EventGraph") => d.graphs.find((g) => g.name === name)!;
const node = (d: BpDoc, id: string, g = "EventGraph") => tab(d, g).nodes.find((n) => n.id === id)!;

test("pin types: exec, numbers, strings, structs, wildcards and lists", () => {
  assert.equal(unrealPinsFit("exec", "exec").ok, true);
  assert.equal(unrealPinsFit("exec", "bool").ok, false);
  assert.deepEqual(unrealPinsFit("int", "real"), { ok: true, why: "int → real" });
  assert.equal(unrealPinsFit("real", "string").ok, true);
  assert.equal(unrealPinsFit("struct:Vector", "string").ok, true);
  assert.equal(unrealPinsFit("string", "real").ok, false);
  assert.equal(unrealPinsFit("string", "name").ok, true);
  assert.equal(unrealPinsFit("bool", "real").ok, false);
  assert.equal(unrealPinsFit("struct:Vector", "struct:Vector").ok, true);
  assert.equal(unrealPinsFit("struct:Vector", "struct:Rotator").ok, false);
  assert.equal(unrealPinsFit("byte:EFoo", "byte:EBar").ok, false);
  assert.equal(unrealPinsFit("int[]", "int").ok, false);
  assert.equal(unrealPinsFit("object:Actor[]", "wildcard[]").ok, true);
  assert.equal(unrealPinsFit("object:Actor", "wildcard[]").ok, false);
  assert.equal(unrealPinsFit("real", "wildcard").ok, true);
  assert.equal(unrealPinsFit("wildcard", "exec").ok, false);
});

test("pin types: objects and classes go into their class or a parent, Blueprints by their parents", () => {
  assert.equal(unrealPinsFit("object:Character", "object:Pawn").ok, true);
  assert.equal(unrealPinsFit("object:Character", "object:Actor").ok, true);
  assert.deepEqual(unrealPinsFit("object:Actor", "object:Pawn"), { ok: false, why: "Actor is not a Pawn" });
  assert.equal(unrealPinsFit("object:StaticMeshComponent", "object:PrimitiveComponent").ok, true);
  assert.equal(unrealPinsFit("object:Actor", "object:ActorComponent").ok, false);
  assert.equal(unrealPinsFit("object:Actor", "object:Object").ok, true);
  assert.equal(unrealPinsFit("class:Character", "class:Actor").ok, true);
  assert.equal(unrealPinsFit("class:Actor", "object:Actor").ok, false);
  assert.equal(unrealPinsFit("object:Actor", "softobject:Actor").ok, true);
  const parents = { BP_Enemy: "Character" };
  assert.equal(unrealPinsFit("object:BP_Enemy_C", "object:Pawn", parents).ok, true);
  assert.equal(unrealPinsFit("object:BP_Enemy_C", "object:PlayerController", parents).ok, false);
  // Not known here: let Unreal decide when it syncs.
  assert.deepEqual(unrealPinsFit("object:BP_Unknown_C", "object:Pawn"), { ok: true, why: "checked by Unreal" });
  assert.equal(isChildClass("Pawn", "Character"), false);
  assert.equal(isChildClass("MyPluginActor", "Pawn"), undefined);
});

test("node kinds: events, pure, functions, macros, loops, casts, timelines, comments and reroutes", () => {
  const d = fixture();
  assert.equal(bpNodeKind(node(d, "E1")), "event");
  assert.equal(bpNodeKind(node(d, "B1")), "flow");
  assert.equal(bpNodeKind(node(d, "G1")), "variable");
  assert.equal(bpNodeKind(node(d, "P1")), "function");
  assert.equal(bpNodeKind({ class: "K2Node_CallFunction", title: "Add", pins: [{ name: "A", dir: "in", type: "real" }] }), "pure");
  assert.equal(isPureNode({ class: "K2Node_CallFunction", pins: [{ name: "A", dir: "in", type: "real" }] }), true);
  assert.equal(bpNodeKind({ class: "K2Node_MacroInstance", title: "For Each Loop", pins: [] }), "loop");
  assert.equal(bpNodeKind({ class: "K2Node_MacroInstance", title: "Gate", pins: [] }), "macro");
  assert.equal(bpNodeKind({ class: "K2Node_DynamicCast", title: "Cast To Pawn", pins: [] }), "cast");
  assert.equal(bpNodeKind({ class: "K2Node_Timeline", title: "Fade", pins: [] }), "timeline");
  assert.equal(bpNodeKind({ class: "EdGraphNode_Comment", title: "x", pins: [] }), "comment");
  assert.equal(bpNodeKind({ class: "K2Node_Knot", title: "", pins: [] }), "reroute");
});

test("add: nodes get their pins and ids, refs carry to later operations, refused ones change nothing", () => {
  const d = fixture();
  const { doc, results } = applyBpOps(d, "EventGraph", [
    { op: "add", type: "call", function: "KismetSystemLibrary:Delay", ref: "$d", x: 900, y: 0 },
    { op: "connect", from: { node: "P1", pin: "then" }, to: { node: "$d", pin: "execute" } },
    { op: "add", type: "set", variable: "Health", ref: "$s" },
    { op: "add", type: "get", variable: "Nope" },
    { op: "add", type: "cast", class: "Character", ref: "$c" },
    { op: "add", type: "macro", macro: "ForEachLoop", ref: "$f" },
    { op: "add", type: "timeline", name: "Fade" },
    { op: "add", type: "event", event: "ReceiveBeginPlay" },
  ], { newId: (n) => `n${n}` });
  assert.deepEqual(results.map((r) => r.ok), [true, true, true, false, true, true, true, true]);
  assert.equal(results[3]!.error, "No variable Nope");
  // The event already exists: Unreal gives the one there.
  assert.equal(results[7]!.node, "E1");
  const delay = node(doc, results[0]!.node!);
  assert.equal(delay.title, "Delay");
  assert.deepEqual(delay.pins.find((p) => p.name === "execute")!.links, ["P1:then"]);
  assert.equal(node(doc, results[2]!.node!).pins.find((p) => p.dir === "in" && p.type !== "exec")!.type, "real");
  assert.ok(node(doc, results[4]!.node!).pins.some((p) => p.name === "AsCharacter" && p.type === "object:Character"));
  // The input is untouched.
  assert.equal(tab(d).nodes.length, 4);
  // A timeline only in the event graph.
  assert.equal(applyBpOps(d, "Open", [{ op: "add", type: "timeline", name: "T" }]).results[0]!.ok, false);
});

test("connect: type checks, one wire into a data input and out of an exec output, wildcards take the type", () => {
  const d = fixture();
  const r1 = applyBpOps(d, "EventGraph", [{ op: "connect", from: { node: "E1", pin: "then" }, to: { node: "P1", pin: "In String" } }]);
  assert.equal(r1.results[0]!.ok, false);
  assert.match(r1.results[0]!.error!, /cannot be connected/);
  // then of BeginPlay moves from Branch to Print String (an exec output keeps one wire).
  const r2 = applyBpOps(d, "EventGraph", [{ op: "connect", from: { node: "E1", pin: "then" }, to: { node: "P1", pin: "execute" } }]);
  assert.deepEqual(node(r2.doc, "E1").pins[0]!.links, ["P1:execute"]);
  assert.equal(node(r2.doc, "B1").pins[0]!.links, undefined);
  // A bool into the string input: a conversion; the typed value goes.
  const r3 = applyBpOps(d, "EventGraph", [{ op: "connect", from: { node: "G1", pin: "IsOpen" }, to: { node: "P1", pin: "InString" } }]);
  assert.equal(r3.results[0]!.ok, true);
  assert.equal(node(r3.doc, "P1").pins[2]!.default, undefined);
  assert.deepEqual(node(r3.doc, "G1").pins[0]!.links, ["B1:Condition", "P1:InString"]);
  // ForEachLoop's wildcard array takes Actor[], and its element pin becomes Actor.
  const r4 = applyBpOps(d, "EventGraph", [
    { op: "add", type: "get", variable: "Targets", ref: "$t" },
    { op: "add", type: "macro", macro: "ForEachLoop", ref: "$f" },
    { op: "connect", from: { node: "$t", pin: "Targets" }, to: { node: "$f", pin: "Array" } },
  ]);
  assert.ok(r4.results.every((r) => r.ok));
  const loop = node(r4.doc, r4.results[1]!.node!);
  assert.equal(loop.pins.find((p) => p.name === "Array")!.type, "object:Actor[]");
  assert.equal(loop.pins.find((p) => p.name === "Array Element")!.type, "object:Actor");
  assert.equal(canConnectBp(tab(d), { node: "G1", pin: "IsOpen" }, { node: "B1", pin: "Condition" }).ok, true);
});

test("set, disconnect, delete, move, comment and resize", () => {
  const d = fixture();
  const { doc, results } = applyBpOps(d, "EventGraph", [
    { op: "set", node: "P1", pin: "In String", value: "Hi" },
    { op: "set", node: "B1", pin: "Condition", value: "maybe" },
    { op: "disconnect", node: "B1", pin: "Condition" },
    { op: "set", node: "B1", pin: "Condition", value: "TRUE" },
    { op: "move", node: "P1", x: 650.4, y: 10 },
    { op: "comment", node: "P1", text: "Says hi" },
    { op: "add", type: "comment_box", ref: "$c", width: 10, height: 99999, text: "Door" },
    { op: "resize", node: "$c", width: 500, height: 300 },
    { op: "delete", node: "E1" },
    { op: "delete", node: "F1" },
  ]);
  assert.deepEqual(results.map((r) => r.ok), [true, false, true, true, true, true, true, true, true, false]);
  assert.match(results[1]!.error!, /true or false/);
  assert.equal(node(doc, "P1").pins[2]!.default, "Hi");
  assert.equal(node(doc, "B1").pins[1]!.default, "true");
  assert.equal(node(doc, "G1").pins[0]!.links, undefined);
  assert.equal(node(doc, "P1").x, 650);
  assert.equal(node(doc, "P1").comment, "Says hi");
  const box = node(doc, results[6]!.node!);
  assert.deepEqual([box.width, box.height], [500, 300]);
  assert.equal(tab(doc).nodes.some((n) => n.id === "E1"), false);
  assert.equal(node(doc, "B1").pins[0]!.links, undefined);
});

test("collapse to function: the nodes move into a new function, a call takes their place, wires go through it", () => {
  const d = fixture();
  const { doc, results } = applyBpOps(d, "EventGraph", [{ op: "collapse", nodes: ["B1", "G1"], name: "CheckOpen" }], { newId: (n) => `c${n}` });
  assert.equal(results[0]!.ok, true, results[0]!.error);
  const fn = doc.graphs.find((g) => g.name === "CheckOpen")!;
  assert.equal(fn.kind, "function");
  assert.deepEqual(fn.nodes.map((n) => n.class).sort(), ["K2Node_FunctionEntry", "K2Node_FunctionResult", "K2Node_IfThenElse", "K2Node_VariableGet"]);
  const call = node(doc, results[0]!.node!);
  assert.equal(call.function, "CheckOpen");
  assert.deepEqual(call.pins.find((p) => p.name === "execute")!.links, ["E1:then"]);
  assert.deepEqual(node(doc, "E1").pins[0]!.links, [`${call.id}:execute`]);
  assert.deepEqual(node(doc, "P1").pins[0]!.links, [`${call.id}:then`]);
  // Inside: the entry starts the branch, the branch's True ends at the return node.
  const entry = fn.nodes.find((n) => n.class === "K2Node_FunctionEntry")!;
  assert.deepEqual(entry.pins.find((p) => p.name === "then")!.links, ["B1:execute"]);
  assert.equal(tab(doc).nodes.some((n) => n.id === "B1"), false);
  // Refused: events, a name taken.
  assert.equal(applyBpOps(d, "EventGraph", [{ op: "collapse", nodes: ["E1"], name: "X" }]).results[0]!.ok, false);
  assert.match(applyBpOps(d, "EventGraph", [{ op: "collapse", nodes: ["B1"], name: "Open" }]).results[0]!.error!, /already has a function/);
});

test("palette: words in any order, context sensitive from a pin, each once", () => {
  const all = [...COMMON_BP_ACTIONS, { title: "Print String", category: "Development", type: "call", function: "KismetSystemLibrary:PrintString" }];
  assert.equal(searchBpActions(all, "print").filter((a) => a.title === "Print String").length, 1);
  assert.ok(searchBpActions(all, "loop each").some((a) => a.macro === "ForEachLoop"));
  const fromBool = searchBpActions(all, "", { type: "bool", dir: "out" });
  assert.ok(fromBool.some((a) => a.type === "branch"));
  assert.ok(!fromBool.some((a) => a.type === "event"));
  const fromActor = searchBpActions(all, "cast", { type: "object:Actor", dir: "out" });
  assert.ok(fromActor.some((a) => a.title === "Cast To Pawn"));
  const fromArray = searchBpActions(all, "", { type: "object:Actor[]", dir: "out" });
  assert.ok(fromArray.some((a) => a.macro === "ForEachLoop"));
  assert.ok(!fromArray.some((a) => a.type === "branch"));
});

test("compile messages are tied to the plugin's nodes, else to a node named in the text", () => {
  const d = fixture();
  const m = mapCompileMessages({
    messages: [{ severity: "error", text: "Accessed None trying to read IsOpen" }, { severity: "warning", text: "Print String is development only" }, { severity: "warning", text: "Something general" }],
    nodes: [{ node: "B1", severity: "error", text: "Condition needs a value" }],
  }, d);
  assert.deepEqual(m[0], { severity: "error", text: "Condition needs a value", node: "B1", graph: "EventGraph" });
  assert.equal(m.find((x) => x.text.startsWith("Print String"))!.node, "P1");
  assert.equal(m.find((x) => x.text.startsWith("Accessed"))!.node, "G1");
  assert.equal(m.find((x) => x.text === "Something general")!.node, undefined);
});

test("serialization round-trips and diff finds what Unreal changed", () => {
  const d = fixture();
  const text = serializeBpDoc(d);
  assert.equal(serializeBpDoc(parseBpDoc(text)), text);
  assert.throws(() => parseBpDoc("{}"), /Not a Blueprint/);
  const { doc } = applyBpOps(d, "EventGraph", [{ op: "move", node: "P1", x: 0, y: 500 }, { op: "add", type: "branch" }]);
  const diff = diffBpGraphs(d, doc);
  assert.equal(diff.same, false);
  assert.equal(diff.moved, 1);
  assert.deepEqual(diff.added, ["Branch"]);
  assert.equal(diffBpGraphs(d, parseBpDoc(text)).same, true);
});

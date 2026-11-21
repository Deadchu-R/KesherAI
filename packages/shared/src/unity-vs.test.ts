import { test } from "node:test";
import assert from "node:assert/strict";
import { applyVsOps, canConnectVs, COMMON_UNITS, diffVsGraphs, noteLines, parseVsDoc, searchUnits, serializeVsDoc, unityPortsFit, type VsDoc } from "./unity-vs.js";

/** A Script Graph as the KesherAI Unity package answers kesher_graph: On Start → If → Debug Log, a group, a variable. */
function fixture(): VsDoc {
  return {
    path: "Assets/Graphs/Door.asset",
    name: "Door",
    parent: "Script Graph",
    variables: [{ name: "speed", type: "Single", default: "3.5" }],
    graphs: [
      {
        name: "Flow",
        kind: "function",
        nodes: [
          { id: "a1", title: "On Start", class: "Start", x: 0, y: 0, pins: [{ name: "trigger", dir: "out", type: "exec", links: ["b2:enter"] }] },
          {
            id: "b2", title: "If", class: "If", x: 300, y: 0,
            pins: [
              { name: "enter", dir: "in", type: "exec", links: ["a1:trigger"] },
              { name: "condition", dir: "in", type: "Boolean", default: "True" },
              { name: "ifTrue", dir: "out", type: "exec", links: ["c3:enter"] },
              { name: "ifFalse", dir: "out", type: "exec" },
            ],
          },
          {
            id: "c3", title: "Debug: Log", class: "InvokeMember", function: "UnityEngine.Debug:Log", x: 600, y: 0,
            pins: [
              { name: "enter", dir: "in", type: "exec", links: ["b2:ifTrue"] },
              { name: "message", dir: "in", type: "object", default: "Open" },
              { name: "exit", dir: "out", type: "exec" },
            ],
          },
          { id: "d4", title: "Speed", class: "GetVariable", x: 0, y: 200, pins: [{ name: "name", dir: "in", type: "String", default: "speed" }, { name: "value", dir: "out", type: "Single" }] },
          { id: "g5", title: "Opening", comment: "Opening", class: "GraphGroup", x: -40, y: -60, width: 900, height: 200, color: "4D7FFFFF", pins: [] },
          { id: "s6", title: "TODO", comment: "TODO", body: "Play a sound", class: "StickyNote", x: 0, y: 400, width: 200, height: 120, pins: [] },
        ],
      },
      { name: "States", kind: "macro", nodes: [] },
    ],
  };
}

test("serialization round-trips the fixture and drops unknown fields", () => {
  const doc = fixture();
  const text = serializeVsDoc(doc);
  assert.deepEqual(parseVsDoc(text), doc);
  assert.equal(serializeVsDoc(parseVsDoc(text)), text);
  const dirty = JSON.parse(text) as { graphs: Array<{ nodes: Array<Record<string, unknown>> }> };
  dirty.graphs[0]!.nodes[0]!.evil = "<script>";
  dirty.graphs[0]!.nodes[0]!.x = "12";
  const clean = parseVsDoc(JSON.stringify(dirty));
  assert.equal("evil" in clean.graphs[0]!.nodes[0]!, false);
  assert.equal(clean.graphs[0]!.nodes[0]!.x, 12);
  assert.throws(() => parseVsDoc('{"name":"x"}'), /Not a Visual Scripting graph/);
});

test("Unity's type rules for wires", () => {
  assert.equal(unityPortsFit("exec", "exec").ok, true);
  assert.equal(unityPortsFit("exec", "Single").ok, false);
  assert.equal(unityPortsFit("Single", "object").ok, true);
  assert.deepEqual(unityPortsFit("Int32", "Single"), { ok: true, why: "Int32 → Single" });
  assert.equal(unityPortsFit("GameObject", "Transform").ok, true);
  assert.equal(unityPortsFit("Vector2", "Vector3").ok, true);
  assert.equal(unityPortsFit("String", "Single").ok, false);
  assert.equal(unityPortsFit("object", "Boolean").ok, true);
  assert.equal(unityPortsFit("Collider[]", "IEnumerable").ok, true);
});

test("add, connect and set with Unity closed; the input is not changed", () => {
  const doc = fixture();
  const before = serializeVsDoc(doc);
  const { doc: out, results } = applyVsOps(doc, "Flow", [
    { op: "add", type: "WaitForSecondsUnit", ref: "$w", x: 900, y: 0 },
    { op: "connect", from: { node: "c3", pin: "exit" }, to: { node: "$w", pin: "enter" } },
    { op: "set", node: "$w", pin: "seconds", value: "2" },
    { op: "connect", from: { node: "d4", pin: "value" }, to: { node: "$w", pin: "seconds" } },
  ]);
  assert.deepEqual(results.map((r) => r.ok), [true, true, true, true]);
  assert.equal(serializeVsDoc(doc), before);
  const w = out.graphs[0]!.nodes.find((n) => n.id === results[0]!.node)!;
  assert.equal(w.title, "Wait For Seconds");
  assert.deepEqual(w.pins.find((p) => p.name === "enter")!.links, ["c3:exit"]);
  assert.deepEqual(out.graphs[0]!.nodes.find((n) => n.id === "c3")!.pins.find((p) => p.name === "exit")!.links, [`${w.id}:enter`]);
  assert.equal(w.pins.find((p) => p.name === "seconds")!.default, "2");
  assert.deepEqual(w.pins.find((p) => p.name === "seconds")!.links, ["d4:value"]);
});

test("type checks and one-wire ports", () => {
  const { doc: out, results } = applyVsOps(fixture(), "Flow", [
    { op: "connect", from: { node: "d4", pin: "value" }, to: { node: "b2", pin: "enter" } },
    { op: "connect", from: { node: "d4", pin: "value" }, to: { node: "c3", pin: "message" } },
    // A control output keeps one wire: On Start's trigger leaves the If and goes to Debug Log.
    { op: "connect", from: { node: "a1", pin: "trigger" }, to: { node: "c3", pin: "enter" } },
  ]);
  assert.equal(results[0]!.ok, false);
  assert.match(results[0]!.error!, /cannot be connected/);
  assert.equal(results[1]!.ok, true);
  const nodes = out.graphs[0]!.nodes;
  assert.deepEqual(nodes.find((n) => n.id === "a1")!.pins[0]!.links, ["c3:enter"]);
  assert.deepEqual(nodes.find((n) => n.id === "b2")!.pins.find((p) => p.name === "enter")!.links, undefined);
  assert.deepEqual(nodes.find((n) => n.id === "c3")!.pins.find((p) => p.name === "enter")!.links!.sort(), ["a1:trigger", "b2:ifTrue"]);
  assert.equal(canConnectVs(out.graphs[0]!, { node: "d4", pin: "value" }, { node: "b2", pin: "condition" }).ok, false);
});

test("delete removes the wires on both sides; move, disconnect, groups", () => {
  const { doc: out, results } = applyVsOps(fixture(), "Flow", [
    { op: "delete", node: "b2" },
    { op: "move", node: "a1", x: 50, y: 60 },
    { op: "add", type: "comment_box", x: 0, y: 0, width: 300, height: 100, text: "Setup" },
    { op: "resize", node: "g5", width: 1000, height: 300 },
    { op: "comment", node: "g5", text: "Door opens" },
    { op: "comment", node: "a1", text: "no" },
    { op: "delete", node: "missing" },
  ]);
  assert.deepEqual(results.map((r) => r.ok), [true, true, true, true, true, false, false]);
  const nodes = out.graphs[0]!.nodes;
  assert.equal(nodes.find((n) => n.id === "b2"), undefined);
  assert.equal(nodes.find((n) => n.id === "a1")!.pins[0]!.links, undefined);
  assert.equal(nodes.find((n) => n.id === "c3")!.pins[0]!.links, undefined);
  assert.equal(nodes.find((n) => n.id === "a1")!.x, 50);
  assert.equal(nodes.find((n) => n.id === results[2]!.node)!.class, "GraphGroup");
  assert.equal(nodes.find((n) => n.id === "g5")!.width, 1000);
  assert.equal(nodes.find((n) => n.id === "g5")!.title, "Door opens");
  const d = applyVsOps(fixture(), "Flow", [{ op: "disconnect", node: "b2", pin: "ifTrue" }]).doc.graphs[0]!.nodes;
  assert.equal(d.find((n) => n.id === "c3")!.pins[0]!.links, undefined);
});

test("the States tab takes states and transitions", () => {
  const { doc: out, results } = applyVsOps(fixture(), "States", [
    { op: "add", type: "flow_state", name: "Idle", ref: "$i" },
    { op: "add", type: "any_state", ref: "$a" },
    { op: "connect", from: { node: "$a", pin: "out" }, to: { node: "$i", pin: "in" } },
    { op: "connect", from: { node: "$i", pin: "out" }, to: { node: "$a", pin: "in" } },
    { op: "add", type: "If" },
  ]);
  assert.deepEqual(results.map((r) => r.ok), [true, true, true, false, false]);
  assert.equal(out.graphs[1]!.nodes[0]!.title, "Idle");
});

test("the palette searches Unity's list, else the common units", () => {
  assert.equal(searchUnits(COMMON_UNITS, "wait")[0]!.title, "Wait For Seconds");
  assert.equal(searchUnits(COMMON_UNITS, "debug log")[0]!.function, "UnityEngine.Debug:Log");
  const reported = [{ title: "Wait For Seconds", category: "Time", type: "WaitForSecondsUnit" }, { title: "Waypoint Follow", category: "Custom", type: "WaypointFollow" }];
  const merged = searchUnits([...reported, ...COMMON_UNITS], "wait");
  assert.equal(merged[0]!.title, "Wait For Seconds");
  assert.equal(merged.some((u) => u.title === "Waypoint Follow"), false);
  assert.equal(merged.filter((u) => u.title === "Wait For Seconds").length, 1);
  assert.equal(searchUnits(COMMON_UNITS, "").length, COMMON_UNITS.length);
});

test("diff for sync on open", () => {
  const saved = fixture();
  assert.equal(diffVsGraphs(saved, fixture()).same, true);
  const now = applyVsOps(saved, "Flow", [{ op: "add", type: "Update" }, { op: "delete", node: "s6" }, { op: "move", node: "a1", x: 10 }, { op: "set", node: "c3", pin: "message", value: "Closed" }]).doc;
  const d = diffVsGraphs(saved, now);
  assert.equal(d.same, false);
  assert.deepEqual(d.added, ["On Update"]);
  assert.deepEqual(d.removed, ["TODO"]);
  assert.equal(d.moved, 1);
  assert.equal(d.values, 1);
});

test("a sticky note's text fits its frame", () => {
  assert.deepEqual(noteLines("Open the door\nthen wait", 400, 200), ["Open the door", "then wait"]);
  const many = noteLines("word ".repeat(200), 120, 80);
  assert.equal(many.length, 2);
  assert.ok(many.every((l) => l.length <= Math.floor((120 - 16) / 7)));
  assert.ok(many[1]!.endsWith("…"));
});

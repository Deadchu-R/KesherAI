import { test } from "node:test";
import assert from "node:assert/strict";
import { ProviderRegistry } from "@kesher/providers";
import { graphTools } from "./graph-edit.js";

test("graph tools list and read a project's graphs; changes need a model", async () => {
  const fake = {
    connected: true,
    list: async () => ({ blueprints: [{ path: "/Game/BP_Door", name: "BP_Door", parent: "Actor" }, { path: "/Game/BP_Key", name: "BP_Key" }], offline: false, project: "Demo" }),
    graph: async () => ({ graph: { path: "/Game/BP_Door", name: "BP_Door", variables: [{ name: "Open", type: "bool" }], graphs: [{ name: "EventGraph", kind: "ubergraph", nodes: [{ id: "n1", title: "Event BeginPlay", x: 0, y: 0, pins: [{ name: "then", dir: "out", type: "exec", links: ["n2.execute"] }] }] }] }, offline: false }),
    request: async () => ({}),
  };
  const tools = Object.fromEntries(graphTools("unreal", fake as never, new ProviderRegistry(), () => undefined).map((t) => [t.spec.name, t]));
  const ctx = { signal: new AbortController().signal, recordChange: () => undefined };
  assert.match((await tools.unreal_list_graphs!.run({ filter: "door" }, ctx)).output, /\/Game\/BP_Door \(Actor\)/);
  const read = (await tools.unreal_read_graph!.run({ path: "/Game/BP_Door" }, ctx)).output;
  assert.match(read, /Open: bool/);
  assert.match(read, /on BeginPlay\(\):/, "read as code");
  assert.match((await tools.unreal_change_graph!.run({ path: "/Game/BP_Door", request: "x" }, ctx)).output, /No chat model/);
  assert.equal(tools.unreal_change_graph!.risk, "write");
});

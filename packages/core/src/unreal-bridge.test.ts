import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { createKesherServer } from "./server.js";
import { blueprintPrompt, parseOps, type BlueprintJson } from "./unreal-bridge.js";

const BP: BlueprintJson = {
  path: "/Game/BP_Door.BP_Door",
  name: "BP_Door",
  parent: "Actor",
  variables: [{ name: "Open", type: "bool" }],
  graphs: [
    {
      name: "EventGraph",
      kind: "event",
      nodes: [
        { id: "AAA", title: "Event BeginPlay", class: "K2Node_Event", x: 0, y: 0, pins: [{ name: "then", dir: "out", type: "exec" }] },
      ],
    },
  ],
};

/** A stand-in for the Unreal Editor with the plugin: answers commands like the plugin does. */
async function fakeEditor(port: number, calls: string[], projectFile?: string, bridge = "0.1.0", sent?: unknown[]) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/unreal/ws`);
  await new Promise((r, j) => (ws.once("open", r), ws.once("error", j)));
  ws.on("message", (d) => {
    const m = JSON.parse(String(d)) as { id: string; cmd: string; ops?: unknown[] };
    calls.push(m.cmd);
    sent?.push(m);
    const result =
      m.cmd === "list" ? { blueprints: [{ path: BP.path, name: BP.name, parent: "Actor" }] }
      : m.cmd === "graph" ? BP
      : m.cmd === "apply" || m.cmd === "vars" ? { results: (m.ops ?? []).map(() => ({ ok: true })), failed: 0 }
      : { ok: true, messages: [] };
    ws.send(JSON.stringify({ id: m.id, ok: true, result }));
  });
  ws.send(JSON.stringify({ event: "hello", project: "DoorGame", engine: "5.5.4", bridge, ...(projectFile ? { projectFile } : {}) }));
  return ws;
}

const until = async (f: () => Promise<boolean>) => {
  for (let i = 0; i < 100 && !(await f()); i++) await new Promise((r) => setTimeout(r, 30));
};

test("the editor connects, its Blueprints are kept, and work with Unreal closed waits in the queue", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "kesher-ue-"));
  const server = await createKesherServer({ dataDir, autodetect: false, pluginRoots: [] });
  // The plugin says where the project is (0.1.3+): kept only when it is a real .uproject here.
  const uproject = join(dataDir, "DoorGame.uproject");
  await writeFile(uproject, "{}");
  await server.app.listen({ port: 0, host: "127.0.0.1" });
  const port = (server.app.server.address() as { port: number }).port;
  const get = async (url: string) => (await server.app.inject({ method: "GET", url })).json() as Record<string, unknown>;
  try {
    assert.equal((await get("/api/unreal")).connected, false);
    const calls: string[] = [];
    const ws = await fakeEditor(port, calls, uproject);
    await until(async () => (await get("/api/unreal")).connected === true);
    const st = await get("/api/unreal");
    assert.equal((st.editor as { project: string }).project, "DoorGame");
    assert.equal((st.editor as { projectFile?: string }).projectFile, uproject);
    assert.match(String(st.download), /KesherAIBridge\.zip$/);

    const list = await get("/api/unreal/blueprints");
    assert.equal((list.blueprints as unknown[]).length, 1);
    assert.equal(list.offline, false);
    const g = await get(`/api/unreal/graph?path=${encodeURIComponent(BP.path)}`);
    assert.equal((g.graph as BlueprintJson).name, "BP_Door");

    // The plugin's own update: the editor is asked to close, and KesherAI waits until it has.
    ws.on("message", (d) => {
      if ((JSON.parse(String(d)) as { cmd: string }).cmd === "quit_for_update") setTimeout(() => ws.close(), 50);
    });
    await server.services.unreal.closeForUpdate(10_000);
    assert.ok(calls.includes("quit_for_update"));
    await until(async () => (await get("/api/unreal")).connected === false);
    // Unreal closed: the saved copy is shown.
    const off = await get(`/api/unreal/graph?path=${encodeURIComponent(BP.path)}`);
    assert.equal(off.offline, true);
    assert.equal((await get("/api/unreal/blueprints")).offline, true);
    // A new Blueprint with Unreal closed: kept with an empty graph, listed, and made first when the editor connects.
    const made = (await server.app.inject({ method: "POST", url: "/api/unreal/create", payload: { name: "BP_Gate", folder: "/Game/Blueprints", parent: "Actor" } })).json() as { path: string; queued: boolean };
    assert.deepEqual(made, { path: "/Game/Blueprints/BP_Gate.BP_Gate", queued: true });
    assert.ok(((await get("/api/unreal/blueprints")).blueprints as Array<{ path: string }>).some((b) => b.path === made.path));
    assert.equal(((await get(`/api/unreal/graph?path=${encodeURIComponent(made.path)}`)).graph as BlueprintJson).name, "BP_Gate");
    assert.equal((await server.app.inject({ method: "POST", url: "/api/unreal/create", payload: { name: "../x", folder: "/Game" } })).statusCode, 400);
    assert.equal((await server.app.inject({ method: "GET", url: "/api/unreal/graph?path=/Game/Never.Never" })).statusCode, 404);

    // A change waits, and is applied when the editor connects again.
    await server.services.unreal.enqueue({ project: "DoorGame", path: BP.path, graph: "EventGraph", ops: [{ op: "add", type: "branch", ref: "$b" }] });
    assert.equal(((await get("/api/unreal/queue")) as unknown as unknown[]).length, 2, "the new Blueprint, then the change");
    const calls2: string[] = [];
    const ws2 = await fakeEditor(port, calls2);
    await until(async () => calls2.includes("apply") && ((await get("/api/unreal/queue")) as unknown as unknown[]).length === 0);
    assert.ok(calls2.includes("apply") && calls2.includes("compile"));
    assert.ok(calls2.indexOf("create") >= 0 && calls2.indexOf("create") < calls2.indexOf("apply"), "the waiting Blueprint is made first");
    ws2.close();

    // Only this computer may connect as the editor.
    const remote = await server.app.inject({ method: "GET", url: "/api/unreal/ws", remoteAddress: "192.168.1.30", headers: { connection: "upgrade", upgrade: "websocket" } });
    assert.notEqual(remote.statusCode, 101);
  } finally {
    await server.app.close();
  }
});

test("blueprintPrompt shows the graph compactly and parseOps reads the model's answer", () => {
  const [system, user] = blueprintPrompt(BP, "EventGraph", "print hello on begin play");
  assert.match(system!.content, /"op":"connect"/);
  assert.match(user!.content, /out then \(exec\)/);
  assert.match(user!.content, /Open \(bool\)/);
  const answer = '<think>hmm</think>Sure:\n```json\n{"ops":[{"op":"add","ref":"$p","type":"call","function":"KismetSystemLibrary:PrintString"},{"op":"connect","from":{"node":"AAA","pin":"then"},"to":{"node":"$p","pin":"execute"}},{"bad":1}],"note":"Prints hello."}\n```';
  const { ops, note } = parseOps(answer);
  assert.equal(ops.length, 2);
  assert.equal(note, "Prints hello.");
  assert.throws(() => parseOps("no json here"), /did not answer/);
  // Pins copied whole from the prompt's pin lines still name the pin.
  const copied = parseOps('{"ops":[{"op":"connect","from":{"node":"AAA","pin":"out then (exec)"},"to":{"node":"$p","pin":"in execute (exec)"}},{"op":"set","node":"$p","pin":"in InString \\"In String\\" (string) = Hi"}]}');
  assert.deepEqual(copied.ops[0], { op: "connect", from: { node: "AAA", pin: "then" }, to: { node: "$p", pin: "execute" } });
  assert.equal(copied.ops[1]!.pin, "InString");
});

test("variables: sent to a plugin that has them, an older plugin is asked to update", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "kesher-ue-vars-"));
  const server = await createKesherServer({ dataDir, autodetect: false, pluginRoots: [] });
  await server.app.listen({ port: 0, host: "127.0.0.1" });
  const port = (server.app.server.address() as { port: number }).port;
  const get = async (url: string) => (await server.app.inject({ method: "GET", url })).json() as Record<string, unknown>;
  const ops = [{ op: "add", name: "Health", type: "real", default: "100", editable: true, tooltip: "Starts full", category: "Stats" }];
  try {
    const old = await fakeEditor(port, []);
    await until(async () => (await get("/api/unreal")).connected === true);
    const refused = await server.app.inject({ method: "POST", url: "/api/unreal/vars", payload: { path: BP.path, ops } });
    assert.equal(refused.statusCode, 409);
    assert.match(refused.json().error, /0\.1\.9/);
    old.close();
    await until(async () => (await get("/api/unreal")).connected === false);

    const sent: Array<{ cmd: string; ops?: unknown[] }> = [];
    const ws = await fakeEditor(port, [], undefined, "0.1.9", sent);
    await until(async () => (await get("/api/unreal")).connected === true);
    const r = await server.app.inject({ method: "POST", url: "/api/unreal/vars", payload: { path: BP.path, ops } });
    assert.equal(r.statusCode, 200);
    const body = r.json() as { failed: number; graph: BlueprintJson };
    assert.equal(body.failed, 0);
    assert.equal(body.graph.name, "BP_Door");
    assert.deepEqual(sent.find((m) => m.cmd === "vars")?.ops, ops);
    assert.equal((await server.app.inject({ method: "POST", url: "/api/unreal/vars", payload: { path: BP.path, ops: [] } })).statusCode, 400);
    ws.close();
  } finally {
    await server.app.close();
  }
});

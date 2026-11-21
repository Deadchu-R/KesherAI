import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { createKesherServer } from "./server.js";
import { blueprintPrompt, parseOps, UnrealBridge, type BlueprintJson } from "./unreal-bridge.js";

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
    // A Blueprint compiled in the editor: the status says when, so the page reads the graph again at once.
    assert.equal(st.changedAt, undefined);
    ws.send(JSON.stringify({ event: "changed" }));
    await until(async () => typeof (await get("/api/unreal")).changedAt === "number");
    assert.ok(Number((await get("/api/unreal/changed")).changedAt) > 0, "the page's cheap check sees the compile");

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

test("Unreal closed: commands run in a headless editor (one start for several), not 'not connected'", async () => {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { UnrealBridge } = await import("./unreal-bridge.js");
  const dir = mkdtempSync(join(tmpdir(), "ub-"));
  const uproject = join(dir, "Game.uproject");
  writeFileSync(uproject, "{}");
  writeFileSync(join(dir, "last.json"), JSON.stringify({ last: "Game", projectFile: uproject }));
  const b = new UnrealBridge(dir);
  const runs: Array<Array<Record<string, unknown>>> = [];
  b.setHeadless(async (file, commands) => {
    assert.equal(file, uproject);
    runs.push(commands);
    return commands.map((c) => (c.cmd === "graph" ? { ok: true, result: { path: c.path, name: "BP", variables: [], graphs: [] } } : c.cmd === "list" ? { ok: true, result: { blueprints: [{ path: "/Game/BP.BP", name: "BP" }] } } : { ok: true, result: { ok: true } }));
  });
  await b.project();
  assert.equal(b.available, true);
  assert.equal((await b.status()).offline, true);
  const g = await b.graph("/Game/BP.BP");
  assert.equal(g.graph.name, "BP");
  assert.equal(g.offline, true);
  await b.graph("/Game/BP.BP");
  assert.equal(runs.length, 1, "the second read uses the saved copy");
  assert.deepEqual(await b.request("compile", { path: "/Game/BP.BP" }), { ok: true });
  const made = await b.createBlueprint("BP_New", "/Game", "Actor");
  assert.equal(made.queued, false);
  assert.deepEqual(runs.at(-1)!.map((c) => c.cmd), ["create", "list"]);
  await assert.rejects(b.request("play", {}), /not connected/);
});

test("Close from KesherAI: the choice (save or not) goes to the editor, the answer waits until it has closed", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "kesher-ue-close-"));
  const server = await createKesherServer({ dataDir, autodetect: false, pluginRoots: [] });
  await server.app.listen({ port: 0, host: "127.0.0.1" });
  const port = (server.app.server.address() as { port: number }).port;
  const get = async (url: string) => (await server.app.inject({ method: "GET", url })).json() as Record<string, unknown>;
  try {
    const closed = await server.app.inject({ method: "POST", url: "/api/unreal/close", payload: { save: true } });
    assert.equal(closed.statusCode, 409, "nothing is open");

    const sent: Array<{ cmd: string; save?: boolean }> = [];
    const ws = await fakeEditor(port, [], undefined, "0.1.18", sent);
    ws.on("message", (d) => {
      if ((JSON.parse(String(d)) as { cmd: string }).cmd === "close_editor") ws.close();
    });
    await until(async () => (await get("/api/unreal")).connected === true);
    const r = await server.app.inject({ method: "POST", url: "/api/unreal/close", payload: { save: true } });
    assert.equal(r.statusCode, 200);
    assert.deepEqual(r.json(), { closed: true, saved: true });
    assert.equal(sent.find((m) => m.cmd === "close_editor")?.save, true);
    assert.equal((await get("/api/unreal")).connected, false);
  } finally {
    await server.app.close();
  }
});

test("the Unreal plugin reports the same version everywhere (its .uplugin, its C++ hello, and KesherAI's latest)", async () => {
  const { readFile } = await import("node:fs/promises");
  const { BRIDGE_VERSION } = await import("./unreal-bridge.js");
  const root = join(import.meta.dirname, "..", "..", "..", "integrations", "unreal", "KesherAIBridge");
  const uplugin = JSON.parse(await readFile(join(root, "KesherAIBridge.uplugin"), "utf8")) as { VersionName: string };
  const cpp = await readFile(join(root, "Source", "KesherAIBridge", "Private", "KesherAIBridgeModule.cpp"), "utf8");
  // Found on the PC: 0.1.18 was installed but the editor said 0.1.17 (the C++ constant was not bumped), so KesherAI
  // kept offering the update it had just made.
  assert.equal(uplugin.VersionName, BRIDGE_VERSION);
  assert.equal(/BridgeVersion = TEXT\("([^"]+)"\)/.exec(cpp)?.[1], BRIDGE_VERSION);
});

test("with Unreal closed, queued changes sync in one headless start: applied, compiled, saved, read again", async () => {
  const { UnrealBridge } = await import("./unreal-bridge.js");
  const { mkdtemp, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "ue-sync-"));
  const proj = join(dir, "Game.uproject");
  await writeFile(proj, "{}");
  const b = new UnrealBridge(dir);
  let sent: Array<Record<string, unknown>> = [];
  b.setHeadless(async (_file, commands) => {
    sent = commands;
    return commands.map((c) => (c.cmd === "graph" ? { ok: true, result: { path: c.path, graphs: [{ name: "EventGraph", nodes: [{ id: "n1" }] }] } } : { ok: true }));
  });
  (b as unknown as { lastProjectFile: string }).lastProjectFile = proj;
  (b as unknown as { project: () => Promise<string> }).project = async () => "Game";
  await b.enqueue({ project: "Game", path: "/Game/BP_A.BP_A", graph: "EventGraph", ops: [{ op: "add" }] });
  await b.enqueue({ project: "Game", path: "/Game/BP_A.BP_A", graph: "EventGraph", ops: [{ op: "connect" }] });
  const r = await b.syncNow();
  assert.deepEqual(r, { applied: 2, failed: 0 });
  // A graph's waiting changes go in one apply (ids of added nodes are refs within it).
  assert.deepEqual(sent.map((c) => c.cmd), ["apply", "compile", "save", "graph"]);
  assert.deepEqual(sent[0]!.ops, [{ op: "add" }, { op: "connect" }]);
  assert.equal((await b.queue()).length, 0);
  assert.equal(b.syncState.running, false);
});

test("Unreal closed: page edits show at once on the copy, refused ones are not queued, undo / redo, palette, compile marks", async () => {
  const root = await mkdtemp(join(tmpdir(), "kesher-ue-"));
  const proj = join(root, "Door");
  await mkdir(join(proj, "Content"), { recursive: true });
  await writeFile(join(proj, "Door.uproject"), "{}");
  const data = join(root, "data");
  await mkdir(data, { recursive: true });
  await writeFile(join(data, "last.json"), JSON.stringify({ last: "DoorGame", projectFile: join(proj, "Door.uproject") }));
  const b = new UnrealBridge(data);
  await assert.rejects(b.enqueueEdit(BP.path, "EventGraph", [{ op: "add", type: "branch" }]), /Open this Blueprint once/);
  await b.remember(BP.path, BP);
  // Added, wired by its ref, and a wire that does not fit (exec into a bool): refused, the rest queued.
  const r = await b.enqueueEdit(BP.path, "EventGraph", [
    { op: "add", type: "branch", ref: "$b", x: 300, y: 0 },
    { op: "connect", from: { node: "AAA", pin: "then" }, to: { node: "$b", pin: "execute" } },
    { op: "connect", from: { node: "AAA", pin: "then" }, to: { node: "$b", pin: "Condition" } },
  ]);
  assert.deepEqual(r.results.map((x) => x.ok), [true, true, false]);
  assert.equal(r.failed, 1);
  const q = await b.queue();
  assert.equal(q.length, 1);
  assert.equal((q[0]!.ops as Array<{ op: string }>).length, 2, "only what Unreal would take is queued");
  const shown = await b.graph(BP.path);
  assert.equal(shown.offline, true);
  assert.equal(shown.pending, 1);
  const branch = shown.graph.graphs[0]!.nodes.find((n) => n.title === "Branch")!;
  assert.match(branch.id, /^new-/);
  assert.deepEqual(branch.pins.find((p) => p.name === "execute")!.links, ["AAA:then"]);
  // A later change can use the new node's id.
  assert.equal((await b.enqueueEdit(BP.path, "EventGraph", [{ op: "set", node: branch.id, pin: "Condition", value: "true" }])).queued, true);
  assert.equal(await b.undoQueued(BP.path), true);
  assert.equal((await b.queue()).length, 1);
  assert.equal(await b.undoQueued(BP.path, true), true);
  assert.equal((await b.queue()).length, 2);
  // Palette with Unreal closed: common nodes, the Blueprint's variables, context sensitive.
  const pal = await b.actions(BP.path, "", { type: "bool", dir: "out" });
  assert.equal(pal.offline, true);
  assert.ok(pal.actions.some((a) => a.type === "branch"));
  assert.ok(pal.actions.some((a) => a.type === "set" && a.variable === "Open"));
  assert.ok(!pal.actions.some((a) => a.type === "event"));
  // A compile's messages are tied to nodes and come with the graph.
  const rec = await b.recordCompile(BP.path, { ok: false, messages: [{ severity: "error", text: "x" }], nodes: [{ node: "AAA", graph: "EventGraph", severity: "error", text: "Event BeginPlay is broken" }] }, BP);
  assert.equal(rec!.ok, false);
  assert.equal((await b.graph(BP.path)).compile!.messages[0]!.node, "AAA");
  // Sync on open with Unreal closed: the .uasset was not saved since the copy.
  assert.equal((await b.checkSaved(BP.path)).same, true);
});

test("Unreal closed: a queued change that clashes with an edit saved in Unreal waits for a choice", async () => {
  const root = await mkdtemp(join(tmpdir(), "kesher-ue-"));
  const proj = join(root, "Shooter");
  await mkdir(join(proj, "Content", "Doors"), { recursive: true });
  await writeFile(join(proj, "Shooter.uproject"), "{}");
  await writeFile(join(proj, "Content", "Doors", "BP_Door.uasset"), "x");
  const old = Date.now() / 1000 - 120;
  await utimes(join(proj, "Content", "Doors", "BP_Door.uasset"), old, old);
  const data = join(root, "data");
  await mkdir(data, { recursive: true });
  await writeFile(join(data, "last.json"), JSON.stringify({ last: "Shooter", projectFile: join(proj, "Shooter.uproject") }));
  const b = new UnrealBridge(data);
  const runs: unknown[][] = [];
  b.setHeadless(async (_f, cmds) => { runs.push(cmds); return cmds.map(() => ({ ok: true })); });
  const path = "/Game/Doors/BP_Door.BP_Door";
  await b.remember(path, { path, name: "BP_Door", variables: [], graphs: [{ name: "EventGraph", kind: "event", nodes: [{ id: "n1", title: "BeginPlay", class: "K2Node_Event", x: 0, y: 0, pins: [] }] }] });
  const q = await b.enqueue({ project: "Shooter", path, graph: "", ops: [{ op: "delete", node: "n1" }] });
  assert.equal(q.baseSig?.n1, "BeginPlay");
  const now = Date.now() / 1000 + 10;
  await utimes(join(proj, "Content", "Doors", "BP_Door.uasset"), now, now);
  const reports: Array<{ clashes: number }> = [];
  b.onSync = (r) => reports.push(r);
  assert.deepEqual(await b.syncNow(), { applied: 0, failed: 0 });
  assert.equal(runs.length, 0, "no headless editor for a clash");
  assert.equal(reports[0]!.clashes, 1);
  // Keep mine: applied at the next sync.
  await b.decide(q.id, "mine");
  assert.deepEqual(await b.syncNow(), { applied: 1, failed: 0 });
  assert.equal(runs.length, 1);
});

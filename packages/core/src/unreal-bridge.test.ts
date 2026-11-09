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
async function fakeEditor(port: number, calls: string[], projectFile?: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/unreal/ws`);
  await new Promise((r, j) => (ws.once("open", r), ws.once("error", j)));
  ws.on("message", (d) => {
    const m = JSON.parse(String(d)) as { id: string; cmd: string; ops?: unknown[] };
    calls.push(m.cmd);
    const result =
      m.cmd === "list" ? { blueprints: [{ path: BP.path, name: BP.name, parent: "Actor" }] }
      : m.cmd === "graph" ? BP
      : m.cmd === "apply" ? { results: (m.ops ?? []).map(() => ({ ok: true })), failed: 0 }
      : { ok: true, messages: [] };
    ws.send(JSON.stringify({ id: m.id, ok: true, result }));
  });
  ws.send(JSON.stringify({ event: "hello", project: "DoorGame", engine: "5.5.4", bridge: "0.1.0", ...(projectFile ? { projectFile } : {}) }));
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

    ws.close();
    await until(async () => (await get("/api/unreal")).connected === false);
    // Unreal closed: the saved copy is shown.
    const off = await get(`/api/unreal/graph?path=${encodeURIComponent(BP.path)}`);
    assert.equal(off.offline, true);
    assert.equal((await get("/api/unreal/blueprints")).offline, true);
    assert.equal((await server.app.inject({ method: "GET", url: "/api/unreal/graph?path=/Game/Never.Never" })).statusCode, 404);

    // A change waits, and is applied when the editor connects again.
    await server.services.unreal.enqueue({ project: "DoorGame", path: BP.path, graph: "EventGraph", ops: [{ op: "add", type: "branch", ref: "$b" }] });
    assert.equal(((await get("/api/unreal/queue")) as unknown as unknown[]).length, 1);
    const calls2: string[] = [];
    const ws2 = await fakeEditor(port, calls2);
    await until(async () => calls2.includes("apply") && ((await get("/api/unreal/queue")) as unknown as unknown[]).length === 0);
    assert.ok(calls2.includes("apply") && calls2.includes("compile"));
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
});

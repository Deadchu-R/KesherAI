import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { createKesherServer } from "./server.js";
import { unityPrompt, type BlueprintJson } from "./unreal-bridge.js";
import { installUnityPackage } from "./unreal-install.js";

const G: BlueprintJson = { path: "Assets/Door.asset", name: "Door", variables: [{ name: "open", type: "Boolean" }], graphs: [{ name: "Door", kind: "event", nodes: [{ id: "u1", title: "Start", class: "Start", x: 0, y: 0, pins: [{ name: "trigger", dir: "out", type: "exec" }] }] }] };

test("the Unity editor connects at /api/unity/ws, separately from Unreal", async () => {
  const server = await createKesherServer({ dataDir: await mkdtemp(join(tmpdir(), "kesher-unity-")), autodetect: false, pluginRoots: [] });
  await server.app.listen({ port: 0, host: "127.0.0.1" });
  const port = (server.app.server.address() as { port: number }).port;
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/unity/ws`);
    await new Promise((r) => ws.once("open", r));
    ws.on("message", (d) => {
      const m = JSON.parse(String(d)) as { id: string; cmd: string };
      ws.send(JSON.stringify({ id: m.id, ok: true, result: m.cmd === "list" ? { blueprints: [{ path: G.path, name: "Door" }] } : G }));
    });
    ws.send(JSON.stringify({ event: "hello", project: "DoorGame", engine: "6000.0.30f1", bridge: "0.1.0" }));
    for (let i = 0; i < 100 && !((await server.app.inject({ url: "/api/unity" })).json() as { connected: boolean }).connected; i++) await new Promise((r) => setTimeout(r, 30));
    const st = (await server.app.inject({ url: "/api/unity" })).json() as { connected: boolean; download: string };
    assert.equal(st.connected, true);
    assert.match(st.download, /com\.kesherai\.bridge$/);
    assert.equal(((await server.app.inject({ url: "/api/unreal" })).json() as { connected: boolean }).connected, false);
    const g = (await server.app.inject({ url: `/api/unity/graph?path=${encodeURIComponent(G.path)}` })).json() as { graph: BlueprintJson };
    assert.equal(g.graph.name, "Door");
    ws.close();
  } finally {
    await server.app.close();
  }
});

test("unityPrompt names Unity's ports and events", () => {
  const [system, user] = unityPrompt(G, "log hello on start");
  assert.match(system!.content, /UnityEngine\.Debug:Log/);
  assert.match(system!.content, /"trigger" → "enter"/);
  assert.match(user!.content, /out trigger \(exec\)/);
});

test("installUnityPackage copies the package into Packages/, and refuses other folders", async () => {
  const dir = await mkdtemp(join(tmpdir(), "unity-proj-"));
  await assert.rejects(installUnityPackage(dir), /not a Unity project/);
  await mkdir(join(dir, "Assets"));
  await mkdir(join(dir, "Packages"));
  await writeFile(join(dir, "Packages", "manifest.json"), "{}");
  await installUnityPackage(dir);
  assert.ok(existsSync(join(dir, "Packages", "com.kesherai.bridge", "package.json")));
  assert.ok(existsSync(join(dir, "Packages", "com.kesherai.bridge", "Editor", "KesherBridge.cs.meta")));
});

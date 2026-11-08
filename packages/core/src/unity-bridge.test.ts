import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UnityCli, readResult, type CliRunner } from "./unity-cli.js";
import { unityPrompt, type BlueprintJson } from "./unreal-bridge.js";
import { installUnityPackage } from "./unreal-install.js";

const G: BlueprintJson = { path: "Assets/Door.asset", name: "Door", variables: [{ name: "open", type: "Boolean" }], graphs: [{ name: "Door", kind: "event", nodes: [{ id: "u1", title: "Start", class: "Start", x: 0, y: 0, pins: [{ name: "trigger", dir: "out", type: "exec" }] }] }] };

test("Unity through its CLI: warm in the open editor, a batch run when it is closed", async () => {
  const calls: string[][] = [];
  let ready = true;
  const run: CliRunner = async (args) => {
    calls.push(args);
    if (args[0] === "--version") return { code: 0, stdout: "1.0.0", stderr: "" };
    if (args[0] === "status") return { code: ready ? 0 : 12, stdout: JSON.stringify({ success: ready }), stderr: "" };
    if (args[0] === "command") return { code: 0, stdout: JSON.stringify(JSON.stringify(args[1] === "kesher_graph" ? G : { blueprints: [{ path: G.path, name: "Door" }] })), stderr: "" };
    if (args[0] === "run") return { code: 0, stdout: `[Licensing] booting\n{"type":"log","line":"x"}\n${JSON.stringify({ type: "result", success: true, data: { result: JSON.stringify(G) } })}`, stderr: "" };
    return { code: 1, stdout: "", stderr: "?" };
  };
  const dir = await mkdtemp(join(tmpdir(), "unity-cli-"));
  await mkdir(join(dir, "Assets"));
  const cfg = { projects: [] as string[] };
  const u = new UnityCli(cfg, async () => undefined, run);
  await assert.rejects(u.request("list"), /Add a Unity project/);
  await u.addProject(dir);
  const list = await u.list();
  assert.equal(list.blueprints[0]!.name, "Door");
  assert.ok(calls.some((c) => c[0] === "command" && c[1] === "kesher_list" && c.includes("--result-only")));
  assert.equal((await u.status()).connected, true);
  ready = false;
  await new Promise((r) => setTimeout(r, 4100));
  const g = await u.graph(G.path);
  assert.equal(g.graph.name, "Door");
  assert.ok(calls.some((c) => c[0] === "run" && c[2] === "--command" && c[3] === "kesher_graph" && c.includes("--path")));
});

test("readResult reads --result-only JSON and a batch run's ndjson, and failures say why", () => {
  assert.deepEqual(readResult(JSON.stringify(JSON.stringify({ a: 1 }))), { a: 1 });
  assert.deepEqual(readResult('noise\n{"type":"result","success":true,"data":"{\\"b\\":2}"}'), { b: 2 });
  assert.throws(() => readResult('{"type":"result","success":false,"errors":[{"message":"No such command"}]}'), /No such command/);
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
  assert.ok(existsSync(join(dir, "Packages", "com.kesherai.bridge", "Editor", "KesherCommands.cs.meta")));
});

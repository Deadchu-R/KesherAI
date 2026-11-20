import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UnityCli, type CliRunner } from "./unity-cli.js";
import { UNITY_TOOL_NAMES, unityTools } from "./unity-tools.js";
import { clampInt } from "./unity-edit-tools.js";

/** A Unity project and a fake `unity` CLI that records every call and answers `script eval` with `answer`. */
async function setup(answer = "ok") {
  const root = await mkdtemp(join(tmpdir(), "kesher-unity-edit-"));
  const project = join(root, "Game");
  await mkdir(join(project, "Assets"), { recursive: true });
  const calls: string[][] = [];
  const run: CliRunner = async (args) => {
    calls.push(args);
    return { code: 0, stdout: JSON.stringify({ success: true, result: answer }), stderr: "" };
  };
  const u = new UnityCli({ projects: [project], active: project }, async () => undefined, run);
  const tools = Object.fromEntries(unityTools(u, join(root, "out"), async () => "a").map((t) => [t.spec.name, t]));
  const ctx = { signal: new AbortController().signal, recordChange: () => undefined };
  /** The C# of the last `script eval` call. */
  const lastCs = () => calls.at(-1)!.at(-1)!;
  return { root, project, calls, tools, ctx, lastCs };
}

test("Unity tool names are sorted and all exist", async () => {
  const { tools } = await setup();
  assert.deepEqual([...UNITY_TOOL_NAMES], [...UNITY_TOOL_NAMES].sort());
  for (const n of UNITY_TOOL_NAMES) assert.ok(tools[n], n);
});

test("unity_scene hierarchy is compact, with depth, filter and root; text reaches C# escaped", async () => {
  const { tools, ctx, lastCs } = await setup("Scene: x");
  assert.equal((await tools.unity_scene!.run({ action: "hierarchy" }, ctx)).output, "Scene: x");
  let cs = lastCs();
  assert.match(cs, /var maxDepth = 4; var limit = 300;/);
  assert.match(cs, /GetInstanceID\(\)/);
  assert.doesNotMatch(cs, /GetComponents</, "the compact tree lists no components");
  await tools.unity_scene!.run({ action: "hierarchy", depth: 99, filter: 'Do"or', root: "#-12" }, ctx);
  cs = lastCs();
  assert.match(cs, /var maxDepth = 20;/);
  assert.ok(cs.includes('var filter = "do\\"or";'));
  assert.ok(cs.includes('var rootKey = "#-12";'));
  assert.equal(clampInt("x", 0, 20, 4), 4);
  assert.equal(clampInt(-3, 0, 20, 4), 0);
});

test("unity_inspect_object reads one object's fields, capped, and checks the component name", async () => {
  const { tools, ctx, calls, lastCs } = await setup("Door #-5");
  assert.equal(tools.unity_inspect_object!.risk, "read");
  assert.equal((await tools.unity_inspect_object!.run({ object: "#-5" }, ctx)).output, "Door #-5");
  let cs = lastCs();
  assert.ok(cs.includes('Resolve("#-5")'));
  assert.match(cs, /var cap = 25;/);
  assert.match(cs, /SerializedObject/);
  assert.match(cs, /more fields/);
  await tools.unity_inspect_object!.run({ object: "Level/Door", component: "Rigidbody", limit: 1000 }, ctx);
  cs = lastCs();
  assert.match(cs, /var only = "Rigidbody"; var cap = 300;/);
  const n = calls.length;
  assert.match((await tools.unity_inspect_object!.run({ object: "Door", component: "x; y" }, ctx)).output, /not a component type name/);
  assert.match((await tools.unity_inspect_object!.run({ object: " " }, ctx)).output, /#id/);
  assert.equal(calls.length, n, "nothing reaches Unity when the input is refused");
});

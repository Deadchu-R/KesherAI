import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { engineChangedAt, graphDiff, nodeSig, opsSummary, sortForSync, unityAssetFile, unrealAssetFile } from "./game-sync.js";
import type { BlueprintJson, QueuedEdit } from "./unreal-bridge.js";

const graph = (nodes: Array<[string, string]>): BlueprintJson => ({ path: "/Game/BP_Door.BP_Door", name: "BP_Door", variables: [], graphs: [{ name: "EventGraph", kind: "event", nodes: nodes.map(([id, title]) => ({ id, title, class: "K2Node", x: 0, y: 0, pins: [] })) }] });

test("a clash shows what each side changed: my operations, the engine's added and removed nodes", () => {
  const base = nodeSig(graph([["a", "BeginPlay"], ["b", "Print String"]]));
  assert.deepEqual(graphDiff(base, graph([["a", "BeginPlay"], ["c", "Delay"]])), { added: ["Delay"], removed: ["Print String"] });
  assert.deepEqual(opsSummary([{ op: "add", type: "call", function: "Lib:Print" }, { op: "delete", node: "b" }, { op: "connect", from: { node: "a", pin: "then" }, to: { node: "$x", pin: "execute" } }], base), ["+ call Lib:Print", "− Print String", "→ BeginPlay ⟶ $x"]);
});

test("graph files: /Game paths and Assets paths only, never outside the project", () => {
  assert.equal(unrealAssetFile("/p", "/Game/Doors/BP_Door.BP_Door"), join("/p", "Content", "Doors", "BP_Door.uasset"));
  assert.equal(unrealAssetFile("/p", "/Engine/X.X"), undefined);
  assert.equal(unrealAssetFile("/p", "/Game/../../etc/x.x"), undefined);
  assert.equal(unityAssetFile("/u", "Assets/Main.unity#Player@0"), join("/u", "Assets", "Main.unity"));
  assert.equal(unityAssetFile("/u", "Assets/../../x.asset"), undefined);
  assert.equal(unityAssetFile("/u", "/etc/passwd"), undefined);
});

test("a change clashes only when the engine saved the file after the copy it was made on", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kesher-sync-"));
  await mkdir(join(dir, "Assets"));
  const file = join(dir, "Assets", "Door.asset");
  await writeFile(file, "x");
  const t = Date.now() / 1000;
  await utimes(file, t - 60, t - 60);
  const q = (id: string, extra: Partial<QueuedEdit> = {}): QueuedEdit => ({ id, project: dir, path: "Assets/Door.asset", graph: "", ops: [], at: new Date().toISOString(), baseAt: new Date((t - 30) * 1000).toISOString(), ...extra });
  assert.equal(await engineChangedAt(q("a"), file), undefined);
  await utimes(file, t, t);
  assert.ok(await engineChangedAt(q("a"), file));
  // No saved copy (an old queue entry) or no file: cannot tell, applied as before.
  assert.equal(await engineChangedAt(q("a", { baseAt: undefined }), file), undefined);
  const r = await sortForSync([q("new"), q("mine", { decision: "mine" }), q("skip", { decision: "skip" }), q("held", { clash: { engineAt: "x" } })], (e) => unityAssetFile(dir, e.path));
  assert.deepEqual(r.apply.map((e) => e.id), ["mine"]);
  assert.deepEqual(r.newClashes.map((e) => e.id), ["new"]);
  assert.ok(r.newClashes[0]!.clash?.engineAt);
});

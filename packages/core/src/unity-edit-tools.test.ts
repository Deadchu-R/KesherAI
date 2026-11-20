import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UnityCli, type CliRunner } from "./unity-cli.js";
import { UNITY_TOOL_NAMES, unityTools } from "./unity-tools.js";
import { clampInt, describeSceneChange, modifyCs, parseSceneChanges, pbrCs, sniffImage } from "./unity-edit-tools.js";

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

test("unity_modify_scene: one schema, checked input, one Undo group, approval for delete or several objects", async () => {
  const { tools, ctx, calls, lastCs } = await setup("moved Door");
  const tool = tools.unity_modify_scene!;
  assert.equal(tool.risk, "write");
  // One object, no delete: no extra question; several objects or a delete: asked, with the count.
  assert.equal(tool.askFirst!({ changes: [{ object: "#-5", action: "move", value: [0, 1, 0] }, { object: "#-5", action: "rename", value: "Gate" }] }), undefined);
  assert.equal(tool.askFirst!({ changes: [{ object: "#-5", action: "delete" }] }), "Changes 1 object in the Unity scene, deleting 1.");
  assert.equal(tool.askFirst!({ changes: [{ object: "A", action: "set_active", value: false }, { object: "B", action: "scale", value: [2, 2, 2] }] }), "Changes 2 objects in the Unity scene.");
  assert.equal(parseSceneChanges([{ object: "A", action: "explode" }]), "Change 1: action is one of move, rotate, scale, rename, reparent, delete, set_active, set_property.");

  const n = calls.length;
  for (const bad of [
    [{ object: "A", action: "move", value: [1, 2] }],
    [{ object: "A", action: "move", value: [1, 2, Infinity] }],
    [{ object: "A", action: "set_active", value: "yes" }],
    [{ object: "A", action: "set_property", component: "Rigid body", property: "m_Mass", value: 2 }],
    [{ object: "A", action: "set_property", component: "Rigidbody", property: "m_Mass; x", value: 2 }],
    [{ object: "A", action: "set_property", component: "Rigidbody", property: "m_Mass", value: { a: 1 } }],
    [{ object: "", action: "delete" }],
    [],
  ]) assert.match((await tool.run({ changes: bad }, ctx)).output, /value|component|property|#id|changes is/, JSON.stringify(bad));
  assert.equal(calls.length, n, "refused input never reaches Unity");

  const out = await tool.run({ changes: [
    { object: "#-5", action: "move", value: [0, 1.5, 0], space: "world" },
    { object: "#-5", action: "reparent", value: "Level" },
    { object: "Old", action: "delete" },
    { object: "#-5", action: "set_property", component: "Rigidbody", property: "m_Mass", value: 2 },
    { object: "#-5", action: "rename", value: 'Ga"te' },
  ] }, ctx);
  assert.equal(out.output, "moved Door");
  const cs = lastCs();
  assert.ok(cs.includes('var keys = new string[] { "#-5", "Level", "Old" };'));
  assert.match(cs, /if \(missing.Count > 0\) return "Nothing changed/);
  assert.match(cs, /Undo.IncrementCurrentGroup\(\)[\s\S]*Undo.CollapseUndoOperations\(group\)/);
  assert.match(cs, /go.transform.position = new UnityEngine.Vector3\(0f, 1.5f, 0f\)/);
  assert.match(cs, /var np = objs\[1\]\.transform/);
  assert.match(cs, /Undo.DestroyObjectImmediate\(go\)/);
  assert.match(cs, /SetNum\(p, 2\)/);
  assert.ok(cs.includes('go.name = "Ga\\"te";'));
  assert.ok(!/SetNum = /.test(modifyCs([{ object: "A", action: "delete" }])), "setters only when a property is set");

  // The approval card lists every change, with the objects' real names when Unity answers.
  const preview = await tool.preview!({ changes: [{ object: "#-5", action: "delete" }, { object: "B", action: "set_active", value: false }] }, ctx);
  assert.match(preview, /2 objects, 1 deleted/);
  assert.match(preview, /1\. #-5: DELETE/);
  assert.match(preview, /2\. B: turn off/);
  assert.equal(describeSceneChange({ object: "A", action: "set_property", component: "Light", property: "m_Color", value: [1, 0, 0] }), "Light.m_Color = (1, 0, 0)");
});

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

test("unity_import_sprite: copies a real picture to Assets/Generated (never over a file) and sets the importer", async () => {
  const { root, project, ctx, calls, lastCs } = await setup("Imported");
  const id = "0b5f7f6e-1c1e-4a7e-9a55-2f2d3c4b5a69";
  const u = new UnityCli({ projects: [project], active: project }, async () => undefined, async (args) => {
    calls.push(args);
    return { code: 0, stdout: JSON.stringify({ success: true, result: "Imported" }), stderr: "" };
  });
  const recorded: string[] = [];
  const tools = Object.fromEntries(
    unityTools(u, join(root, "out"), async () => "a", () => [], async (a) => (a === id ? { data: PNG, mimeType: "image/png" } : undefined)).map((t) => [t.spec.name, t]),
  );
  const rctx = { ...ctx, recordChange: (p: string) => void recorded.push(p) };
  const tool = tools.unity_import_sprite!;

  const out = await tool.run({ file: id, name: "Hero/../x", pixels_per_unit: 32, filter: "point", compression: "none" }, rctx);
  assert.match(out.output, /Copied the picture to Assets\/Generated\/Hero____x\.png\.\nImported/);
  assert.deepEqual(await readFile(join(project, "Assets/Generated/Hero____x.png")), Buffer.from(PNG));
  assert.deepEqual(recorded, [join(project, "Assets/Generated/Hero____x.png")]);
  const cs = lastCs();
  assert.match(cs, /spritePixelsPerUnit = 32;/);
  assert.match(cs, /FilterMode\.Point;/);
  assert.match(cs, /TextureImporterCompression\.Uncompressed;/);
  assert.match(cs, /SpriteImportMode\.Single/);
  // A second import with the same name gets its own file.
  assert.match((await tool.run({ file: id, name: "Hero/../x" }, rctx)).output, /Hero____x-2\.png/);

  // A file on this computer: only a real picture is copied; Assets/ paths are used in place.
  const fake = join(root, "secret.png");
  await writeFile(fake, "not a picture");
  const n = calls.length;
  assert.match((await tool.run({ file: fake }, rctx)).output, /not a picture Unity imports/);
  const webp = join(root, "a.webp");
  await writeFile(webp, Buffer.concat([Buffer.from("RIFF0000WEBP"), Buffer.alloc(8)]));
  assert.match((await tool.run({ file: webp }, rctx)).output, /cannot import WebP/);
  assert.match((await tool.run({ file: "relative.png" }, rctx)).output, /Give a picture/);
  assert.match((await tool.run({ file: "Assets/../../x.png" }, rctx)).output, /outside/);
  assert.equal(calls.length, n, "refused files never reach Unity");
  await writeFile(join(project, "Assets/Tree.png"), PNG);
  const inPlace = await tool.run({ file: "Assets/Tree.png" }, rctx);
  assert.doesNotMatch(inPlace.output, /Copied/);
  assert.ok(lastCs().includes('var path = "Assets/Tree.png";'));
  assert.equal(sniffImage(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0])), "jpg");
  assert.match(await tool.preview!({ file: id, name: "Hero" }, rctx), /to: Assets\/Generated\/Hero\n.*100 pixels per unit, bilinear filter, normal compression/);
});

test("unity_create_pbr_material: maps copied next to the material, pipeline found in Unity, applied with Undo", async () => {
  const { root, project, ctx, calls, lastCs } = await setup("Made");
  const id = "1b5f7f6e-1c1e-4a7e-9a55-2f2d3c4b5a69";
  const u = new UnityCli({ projects: [project], active: project }, async () => undefined, async (args) => {
    calls.push(args);
    return { code: 0, stdout: JSON.stringify({ success: true, result: "Made Assets/Generated/Rust/Rust.mat" }), stderr: "" };
  });
  const tools = Object.fromEntries(unityTools(u, join(root, "out"), async () => "a", () => [], async () => ({ data: PNG, mimeType: "image/png" })).map((t) => [t.spec.name, t]));
  const tool = tools.unity_create_pbr_material!;
  await writeFile(join(project, "Assets/n.png"), PNG);
  const n = calls.length;
  assert.match((await tool.run({ name: "Rust", maps: { roughness: id, smoothness: id } }, ctx)).output, /OR smoothness/);
  assert.match((await tool.run({ name: "Rust", maps: { height: id } }, ctx)).output, /Unknown map height/);
  assert.match((await tool.run({ name: "Rust", maps: {} }, ctx)).output, /at least one map/);
  assert.match((await tool.run({ name: "Rust", maps: { albedo: id }, apply_to: "Door" }, ctx)).output, /apply_to is a list/);
  assert.equal(calls.length, n);

  const out = await tool.run({ name: "Rust", maps: { albedo: id, normal: "Assets/n.png", roughness: id }, apply_to: ["#-5", "selection"] }, ctx);
  assert.match(out.output, /Copied Assets\/Generated\/Rust\/Rust_albedo\.png, Assets\/Generated\/Rust\/Rust_roughness\.png\.\nMade/);
  const cs = lastCs();
  assert.match(cs, /GraphicsSettings\.currentRenderPipeline/);
  assert.match(cs, /"Universal Render Pipeline\/Lit"/);
  assert.match(cs, /"HDRP\/Lit"/);
  assert.match(cs, /Tex\("Assets\/n.png", 1\)/, "the normal map is imported as a normal map");
  assert.match(cs, /Tex\("Assets\/Generated\/Rust\/Rust_roughness.png", 2\)/);
  assert.match(cs, /var smooth = Tex\("", 2\)/);
  assert.match(cs, /255 - gp\[i\]\.r/, "roughness becomes smoothness");
  assert.match(cs, /new string\[\] \{ "#-5" \}/);
  assert.match(cs, /Selection\.gameObjects/);
  assert.match(cs, /Undo\.RecordObject\(r, "KesherAI: material"\)[\s\S]*CollapseUndoOperations/);

  assert.equal(tool.askFirst!({ apply_to: ["#-5"] }), undefined);
  assert.equal(tool.askFirst!({ apply_to: ["A", "B"] }), "Changes 2 objects in the Unity scene.");
  assert.equal(tool.askFirst!({ apply_to: ["selection"] }), "Changes the selected objects in the Unity scene.");
  assert.match(await tool.preview!({ name: "Rust", maps: { albedo: id }, apply_to: ["A", "B"] }, ctx), /Rust\/Rust\.mat[\s\S]*albedo: [\s\S]*Put it on: A, B/);
  assert.doesNotMatch(pbrCs({ name: "M", folder: "Assets/Generated/M", maps: { albedo: "Assets/a.png" }, apply: [], selection: false }), /Selection\.gameObjects/);
});

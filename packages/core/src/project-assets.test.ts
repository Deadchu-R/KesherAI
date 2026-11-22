import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { decodePsd, decodeTga, flatToPng } from "./flat-image.js";
import { GameCheckpoints } from "./game-checkpoints.js";
import { ProjectSaves, exportKey, listUnityAssets, planSave, pluginCanExport, safeAssetPath, sniffSave, unrealExport } from "./project-assets.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
const GLB = Buffer.concat([Buffer.from("glTF"), Buffer.alloc(12)]);
const WAV = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WAVEfmt "), Buffer.alloc(8)]);

/** A Unity project with a few assets of each kind (and things that must not be listed). */
async function unityFixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "kesher-pa-"));
  await mkdir(join(dir, "ProjectSettings"), { recursive: true });
  for (const f of ["Models/Rock.fbx", "Models/Tree.glb", "Models/Lamp.prefab", "Models/Old.blend", "Textures/Rock.png", "Textures/Bark.tga", "Textures/Sky.psd", "Audio/Hit.wav", "Audio/Music.ogg", "Video/Intro.mp4", "Scripts/Player.cs", ".hidden/Secret.png", "Temp~/Junk.png"]) {
    await mkdir(join(dir, "Assets", f, ".."), { recursive: true });
    await writeFile(join(dir, "Assets", f), f.endsWith(".png") ? PNG : f.endsWith(".glb") ? GLB : f.endsWith(".wav") ? WAV : "x");
    await writeFile(join(dir, "Assets", `${f}.meta`), "guid: 0\n");
  }
  return dir;
}

test("a Unity project's assets are listed by the editor's kinds (no .blend, scripts, .meta or hidden folders)", async () => {
  const dir = await unityFixture();
  const names = async (k: Parameters<typeof listUnityAssets>[1]) => (await listUnityAssets(dir, k)).items.map((i) => i.path);
  assert.deepEqual(await names(["model"]), ["Assets/Models/Lamp.prefab", "Assets/Models/Rock.fbx", "Assets/Models/Tree.glb"]);
  assert.deepEqual(await names(["image"]), ["Assets/Textures/Bark.tga", "Assets/Textures/Rock.png", "Assets/Textures/Sky.psd"]);
  assert.deepEqual(await names(["audio", "video"]), ["Assets/Audio/Hit.wav", "Assets/Audio/Music.ogg", "Assets/Video/Intro.mp4"]);
  const items = (await listUnityAssets(dir, ["model", "image"])).items;
  assert.equal(items.find((i) => i.name === "Lamp")?.prefab, true);
  assert.equal(items.find((i) => i.path.endsWith("Rock.png"))?.thumb, true);
  assert.equal(items.find((i) => i.path.endsWith("Bark.tga"))?.thumb, undefined);
});

test("paths are only inside the project: no .., absolute paths, other folders, other types or links out", async () => {
  const dir = await unityFixture();
  assert.equal((await safeAssetPath("unity", dir, "Assets\\Models\\Rock.fbx")).rel, "Assets/Models/Rock.fbx");
  for (const bad of ["Assets/../ProjectSettings/x.png", "../x.png", "/etc/passwd", "C:/Windows/x.png", "ProjectSettings/x.png", "Assets/Scripts/Player.cs", "Assets/Models/Rock.fbx.meta", "Assets//x.png", "Assets/./x.png", "Assets/x\0.png", ""])
    await assert.rejects(safeAssetPath("unity", dir, bad), (e: Error & { statusCode?: number }) => e.statusCode === 400, bad);
  await assert.rejects(safeAssetPath("unreal", dir, "Assets/Models/Rock.fbx"), /Content/);
  const outside = await mkdtemp(join(tmpdir(), "kesher-pa-out-"));
  await writeFile(join(outside, "x.png"), PNG);
  await symlink(outside, join(dir, "Assets", "Linked"), "junction").catch(() => undefined);
  if (existsSync(join(dir, "Assets", "Linked"))) await assert.rejects(safeAssetPath("unity", dir, "Assets/Linked/x.png"), /outside|link/);
});

test("Unreal exports are kept by project, asset path, file time and size; a change exports again; old plugins are told", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kesher-pa-ue-"));
  await mkdir(join(dir, "Content", "Props"), { recursive: true });
  const asset = join(dir, "Content", "Props", "SM_Rock.uasset");
  await writeFile(asset, "pkg");
  const cacheDir = join(dir, "..", `${dir.split(/[\\/]/).pop()}-cache`);
  const calls: Array<{ cmd: string; args: Record<string, unknown> }> = [];
  const run = async (_f: string, cmd: string, args: Record<string, unknown>) => {
    calls.push({ cmd, args });
    await writeFile(String(args.file), `fbx-${calls.length}`);
    return { file: args.file };
  };
  const o = { cacheDir, project: dir, projectFile: join(dir, "Game.uproject"), rel: "Content/Props/SM_Rock.uasset", run, classOf: async () => "StaticMesh" };
  const a = await unrealExport(o);
  assert.equal(a.format, "fbx");
  assert.equal(a.cached, false);
  assert.equal(calls[0]!.cmd, "asset_export");
  assert.equal(calls[0]!.args.path, "/Game/Props/SM_Rock");
  assert.match(String(calls[0]!.args.file), /Saved[\\/]KesherAI[\\/]exports[\\/][0-9a-f]{40}\.fbx$/);
  assert.equal(existsSync(String(calls[0]!.args.file)), false, "the export in the project is moved into the cache");
  assert.equal((await unrealExport(o)).cached, true);
  assert.equal(calls.length, 1);
  await utimes(asset, new Date(), new Date(Date.now() + 5000));
  const b = await unrealExport(o);
  assert.equal(b.cached, false);
  assert.notEqual(b.file, a.file);
  assert.equal(await readFile(b.file, "utf8"), "fbx-2");
  // The key: same inputs, same key; any change, a new one.
  const k = exportKey("/p", "Content/A.uasset", 1000.4, 10, "png");
  assert.equal(k, exportKey("/P", "Content/A.uasset", 1000.9, 10, "png"));
  for (const other of [exportKey("/p", "Content/B.uasset", 1000, 10, "png"), exportKey("/p", "Content/A.uasset", 2000, 10, "png"), exportKey("/p", "Content/A.uasset", 1000, 11, "png"), exportKey("/p", "Content/A.uasset", 1000, 10, "wav")]) assert.notEqual(other, k);
  await assert.rejects(unrealExport({ ...o, classOf: async () => "Material" }), (e: Error & { statusCode?: number }) => e.statusCode === 415);
  assert.equal(pluginCanExport("0.1.32"), false);
  assert.equal(pluginCanExport("0.1.33"), true);
  assert.equal(pluginCanExport("0.2.0"), true);
  assert.equal(pluginCanExport(undefined), false);
});

test("where a save goes: in place only for the same format, else a new asset next to it", () => {
  const taken = new Set(["Assets/M/Rock-edited.glb"]);
  assert.equal(planSave("unity", "Assets/M/Tree.glb", "glb", "replace", () => false), "Assets/M/Tree.glb");
  assert.throws(() => planSave("unity", "Assets/M/Rock.fbx", "glb", "replace", () => false), /Save as new asset/);
  assert.equal(planSave("unity", "Assets/M/Rock.fbx", "glb", "new", (r) => taken.has(r)), "Assets/M/Rock-edited-2.glb");
  assert.throws(() => planSave("unity", "Assets/M/Rock.fbx", "png", "new", () => false), /same kind/);
  assert.equal(planSave("unreal", "Content/P/T_Rock.uasset", "png", "replace", () => false, "Texture2D"), "Content/P/T_Rock.uasset");
  assert.equal(planSave("unreal", "Content/P/SM_Rock.uasset", "glb", "new", () => false, "StaticMesh"), "Content/P/SM_Rock_Edited.uasset");
  assert.throws(() => planSave("unreal", "Content/P/SM_Rock.uasset", "wav", "replace", () => false, "StaticMesh"), /same kind/);
  assert.equal(sniffSave(PNG), "png");
  assert.equal(sniffSave(GLB), "glb");
  assert.equal(sniffSave(WAV), "wav");
  assert.equal(sniffSave(Buffer.from("<script>alert(1)</script>")), undefined);
  // The 3D editor's material graph: Unity only, always a new asset next to the model.
  assert.equal(sniffSave(Buffer.from('{\n    "m_SGVersion": 3,\n')), "shadergraph");
  assert.equal(planSave("unity", "Assets/M/Rock.fbx", "shadergraph", "new", (r) => r === "Assets/M/Rock.shadergraph"), "Assets/M/Rock-2.shadergraph");
  assert.throws(() => planSave("unity", "Assets/M/Rock.fbx", "shadergraph", "replace", () => false), /new asset/);
  assert.throws(() => planSave("unreal", "Content/P/SM_Rock.uasset", "shadergraph", "new", () => false, "StaticMesh"), /come next/);
});

test("a save waits for approval, keeps a checkpoint first, writes Unity's file in place (never .meta)", async () => {
  const dir = await unityFixture();
  const store = await mkdtemp(join(tmpdir(), "kesher-pa-cp-"));
  const cps = new GameCheckpoints(() => store);
  const saves = new ProjectSaves({ dir: join(store, "pending"), checkpoints: cps });
  const meta = await readFile(join(dir, "Assets", "Textures", "Rock.png.meta"), "utf8");
  const edited = Buffer.concat([PNG, Buffer.from("edited")]);
  const s = await saves.stage({ engine: "unity", project: dir, projectName: "Game", path: "Assets/Textures/Rock.png", mode: "replace", fromPhone: false }, edited);
  assert.equal(s.state, "pending");
  assert.equal(s.target, "Assets/Textures/Rock.png");
  assert.deepEqual(await readFile(join(dir, "Assets", "Textures", "Rock.png")), PNG, "nothing is written before approval");
  const done = await saves.approve(s.id);
  assert.equal(done.state, "done");
  assert.deepEqual(await readFile(join(dir, "Assets", "Textures", "Rock.png")), edited);
  assert.equal(await readFile(join(dir, "Assets", "Textures", "Rock.png.meta"), "utf8"), meta);
  const cp = await cps.get(done.checkpoint!);
  assert.equal(cp?.source, "editor");
  assert.deepEqual(cp?.files.map((f) => f.rel), ["Assets/Textures/Rock.png"]);
  await assert.rejects(saves.approve(s.id), /not waiting/);
  // A new asset next to an FBX; the wrong kind and an unknown format are refused.
  const n = await saves.stage({ engine: "unity", project: dir, projectName: "Game", path: "Assets/Models/Rock.fbx", mode: "new", fromPhone: false }, GLB);
  assert.equal(n.target, "Assets/Models/Rock-edited.glb");
  await saves.approve(n.id);
  assert.ok(existsSync(join(dir, "Assets", "Models", "Rock-edited.glb")));
  await assert.rejects(saves.stage({ engine: "unity", project: dir, projectName: "Game", path: "Assets/Models/Rock.fbx", mode: "new", fromPhone: false }, Buffer.from("MZ not a model")), (e: Error & { statusCode?: number }) => e.statusCode === 415);
  await assert.rejects(saves.stage({ engine: "unity", project: dir, projectName: "Game", path: "Assets/../x.png", mode: "new", fromPhone: false }, PNG), /inside the project/);
  // A phone's save tells the computer, and can be discarded.
  const told: string[] = [];
  const phone = new ProjectSaves({ dir: join(store, "pending2"), onStaged: (x) => told.push(x.target) });
  const p = await phone.stage({ engine: "unity", project: dir, projectName: "Game", path: "Assets/Audio/Hit.wav", mode: "replace", fromPhone: true }, WAV);
  assert.deepEqual(told, ["Assets/Audio/Hit.wav"]);
  assert.equal(await phone.discard(p.id), true);
  await assert.rejects(phone.approve(p.id), /not waiting/);
});

test("an Unreal save: the .uasset is kept, then the plugin imports the file from Saved/KesherAI/imports", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kesher-pa-ue-"));
  await mkdir(join(dir, "Content", "Props"), { recursive: true });
  await writeFile(join(dir, "Content", "Props", "SM_Rock.uasset"), "pkg-before");
  const store = await mkdtemp(join(tmpdir(), "kesher-pa-cp-"));
  const cps = new GameCheckpoints(() => store);
  const runs: Array<{ cmd: string; args: Record<string, unknown>; had: boolean }> = [];
  const saves = new ProjectSaves({
    dir: join(store, "pending"),
    checkpoints: cps,
    classOf: async () => "StaticMesh",
    unreal: async (_f, cmd, args) => {
      runs.push({ cmd, args, had: existsSync(String(args.file)) });
      await writeFile(join(dir, "Content", "Props", "SM_Rock.uasset"), "pkg-after");
      return { asset: "/Game/Props/SM_Rock.SM_Rock" };
    },
  });
  const s = await saves.stage({ engine: "unreal", project: dir, projectName: "Game", projectFile: join(dir, "Game.uproject"), path: "Content/Props/SM_Rock.uasset", mode: "replace", fromPhone: false }, GLB);
  assert.equal(runs.length, 0);
  const done = await saves.approve(s.id);
  assert.equal(done.state, "done", done.error);
  assert.equal(runs[0]!.cmd, "asset_import");
  assert.equal(runs[0]!.args.path, "/Game/Props/SM_Rock");
  assert.equal(runs[0]!.args.name, "SM_Rock");
  assert.match(String(runs[0]!.args.file), /Saved[\\/]KesherAI[\\/]imports[\\/].+\.glb$/);
  assert.ok(runs[0]!.had);
  assert.equal(existsSync(String(runs[0]!.args.file)), false, "the import file is removed after");
  const cp = await cps.get(done.checkpoint!);
  assert.deepEqual(cp?.files.map((f) => f.rel), ["Content/Props/SM_Rock.uasset"]);
  // A failing import is reported, not thrown.
  const bad = new ProjectSaves({ dir: join(store, "p3"), classOf: async () => "StaticMesh", unreal: async () => { throw new Error("Unknown command: asset_import"); } });
  const b = await bad.stage({ engine: "unreal", project: dir, projectName: "Game", projectFile: join(dir, "Game.uproject"), path: "Content/Props/SM_Rock.uasset", mode: "new", fromPhone: false }, GLB);
  assert.equal(b.target, "Content/Props/SM_Rock_Edited.uasset");
  const r = await bad.approve(b.id);
  assert.equal(r.state, "failed");
  assert.match(r.error!, /Unknown command/);
});

test("TGA (raw and RLE) and a PSD's flattened picture turn into PNG", () => {
  // 2x1 TGA, 24-bit, bottom-up: blue then red pixel (BGR).
  const tga = Buffer.from([0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0, 1, 0, 24, 0, 255, 0, 0, 0, 0, 255]);
  assert.deepEqual([...decodeTga(tga).data], [0, 0, 255, 255, 255, 0, 0, 255]);
  // RLE: one packet repeating a green pixel twice, 32-bit with alpha 128.
  const rle = Buffer.from([0, 0, 10, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0, 1, 0, 32, 0x20, 0x81, 0, 255, 0, 128]);
  assert.deepEqual([...decodeTga(rle).data], [0, 255, 0, 128, 0, 255, 0, 128]);
  assert.throws(() => decodeTga(Buffer.from([0, 1, 1, ...Array(15).fill(0)])), /true-colour/);
  // PSD 1x1 RGB, raw: R=10 G=20 B=30.
  const head = Buffer.alloc(26);
  head.write("8BPS", 0, "latin1");
  head.writeUInt16BE(1, 4);
  head.writeUInt16BE(3, 12);
  head.writeUInt32BE(1, 14);
  head.writeUInt32BE(1, 18);
  head.writeUInt16BE(8, 22);
  head.writeUInt16BE(3, 24);
  const psd = Buffer.concat([head, Buffer.alloc(12), Buffer.from([0, 0, 10, 20, 30])]);
  assert.deepEqual([...decodePsd(psd).data], [10, 20, 30, 255]);
  // PackBits: each channel's row is "repeat 1 byte twice" (2 wide).
  const head2 = Buffer.from(head);
  head2.writeUInt32BE(2, 18);
  const counts = Buffer.from([0, 2, 0, 2, 0, 2]);
  const psdRle = Buffer.concat([head2, Buffer.alloc(12), Buffer.from([0, 1]), counts, Buffer.from([0xff, 7, 0xff, 8, 0xff, 9])]);
  assert.deepEqual([...decodePsd(psdRle).data], [7, 8, 9, 255, 7, 8, 9, 255]);
  const png = flatToPng(tga, "tga");
  assert.equal(sniffSave(png), "png");
  const idat = png.indexOf("IDAT");
  const rows = inflateSync(png.subarray(idat + 4, idat + 4 + png.readUInt32BE(idat - 4)));
  assert.deepEqual([...rows], [0, 0, 0, 255, 255, 255, 0, 0, 255]);
});

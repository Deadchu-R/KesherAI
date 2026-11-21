import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@kesher/agent";
import type { JobProgress } from "@kesher/shared";
import { AssetStore } from "./assets.js";
import { encodePng, readPicture, SEAM_LIMIT, seamScore, type ApiGraph, type ComfyGraphRunner } from "./pbr-flow.js";
import { pbrTools } from "./pbr-tools.js";
import { quickActionProblem } from "./chat-quick-actions.js";
import { UnityCli } from "./unity-cli.js";
import { unityTools } from "./unity-tools.js";

/** A w×h RGB PNG: a ramp (a hard seam when tiled) or whole-period waves (tiles). */
function png(tiles: boolean, w = 64, h = 64): Uint8Array {
  const data = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const v = tiles ? 128 + 60 * Math.sin((2 * Math.PI * x * 2) / w) + 40 * Math.cos((2 * Math.PI * y) / h) : (x / w) * 200 + (y / h) * 50;
    data.fill(Math.round(v), (y * w + x) * 3, (y * w + x) * 3 + 3);
  }
  return encodePng(w, h, 3, data);
}

const ALL_NODES = ["CheckpointLoaderSimple", "CLIPTextEncode", "EmptyLatentImage", "KSampler", "VAEDecode", "SaveImage", "LoadImage", "ImageCrop", "ImageCompositeMasked", "SolidMask", "MaskComposite", "VAEEncodeForInpaint", "GrowMask"];

/** A fake ComfyUI: records each graph it runs; the first picture has a seam (or not), the fix graph's tiles. */
function fakeComfy(o: { nodes?: string[]; checkpoints?: string[]; installed?: boolean; seam?: boolean } = {}) {
  const graphs: ApiGraph[] = [];
  const uploads: string[] = [];
  const comfy: ComfyGraphRunner = {
    state: () => ({ installed: o.installed ?? true, allowed: true }),
    nodes: async () => new Set(o.nodes ?? ALL_NODES),
    checkpoints: async () => o.checkpoints ?? ["ace_step.safetensors", "juggernautXL.safetensors"],
    run: async (build, _signal, onProgress) => {
      const g = await build(async (_data, name) => (uploads.push(name), name));
      graphs.push(g);
      onProgress?.({ phase: "sampling", step: 1, steps: 2 });
      const fix = Object.values(g).some((n) => n.class_type === "LoadImage");
      const count = Number(Object.values(g).find((n) => n.class_type === "EmptyLatentImage")?.inputs.batch_size ?? 1);
      return Array.from({ length: fix ? 1 : count }, (_, i) => ({ data: png(fix || !(o.seam ?? true)), mimeType: "image/png", filename: `KesherAI/pbr_${i}.png` }));
    },
  };
  return { comfy, graphs, uploads };
}

async function store() {
  return new AssetStore(await mkdtemp(join(tmpdir(), "kesher-pbr-")));
}

function context() {
  const progress: JobProgress[] = [];
  return { progress, ctx: { signal: new AbortController().signal, recordChange: () => undefined, jobProgress: (p: JobProgress) => void progress.push(p) } };
}

test("make_pbr_texture: albedo in ComfyUI, the seam fixed, maps made, sets listed for the buttons", async () => {
  const { comfy, graphs, uploads } = fakeComfy({ seam: true });
  const assets = await store();
  const tool = pbrTools({ comfy, assets }).find((t) => t.spec.name === "make_pbr_texture")!;
  const { ctx, progress } = context();
  const out = await tool.run({ prompt: "old red brick wall" }, ctx);
  assert.equal(graphs.length, 2, "the albedo, then the seam fix");
  assert.equal(graphs[0]!["1"]!.inputs.ckpt_name, "juggernautXL.safetensors");
  assert.equal(graphs[0]!["7"]!.class_type, "VAEDecode", "no seamless-tiling nodes here");
  assert.equal(graphs[1]!["10"]!.inputs.image, uploads[0]);
  assert.match(out.output, /Made 1 PBR texture set\(s\) "Old Red Brick" with juggernautXL/);
  const set = /Set 1: albedo=(\S+) normal=(\S+) roughness=(\S+) ao=(\S+) height=(\S+) \(64x64, seam fixed, seam ([\d.]+)\)/.exec(out.output);
  assert.ok(set, out.output);
  assert.ok(Number(set[6]) < SEAM_LIMIT);
  assert.deepEqual(out.assetIds, [set[1]]);
  const normal = await assets.get(set[2]!);
  assert.equal(normal?.asset.meta?.pbr, "normal");
  assert.ok(seamScore(readPicture(normal!.data)!) < SEAM_LIMIT);
  assert.match(out.output, /apply_to \["selection"\]/);
  assert.deepEqual(progress.map((p) => p.phase).filter((p) => p !== "sampling"), ["queued", "seam check", "fixing seam", "maps"]);
});

test("make_pbr_texture: tiled in the model when ComfyUI has the nodes; 4 variations in one batch", async () => {
  const { comfy, graphs } = fakeComfy({ nodes: [...ALL_NODES, "SeamlessTile", "CircularVAEDecode"], seam: false });
  const tool = pbrTools({ comfy, assets: await store() }).find((t) => t.spec.name === "make_pbr_texture")!;
  const out = await tool.run({ prompt: "mossy stone", count: 4, name: "Moss" }, context().ctx);
  assert.equal(graphs.length, 1, "no fix needed");
  assert.equal(graphs[0]!["2"]!.class_type, "SeamlessTile");
  assert.equal((out.output.match(/^Set \d: /gm) ?? []).length, 4);
  assert.match(out.output, /tiled while made/);
  assert.equal(out.assetIds?.length, 4);
});

test("make_pbr_texture: plain-words answers when ComfyUI, its nodes or a checkpoint are missing", async () => {
  const run = async (o: Parameters<typeof fakeComfy>[0]) => (await pbrTools({ comfy: fakeComfy(o).comfy, assets: await store() })[0]!.run({ prompt: "wood" }, context().ctx)).output;
  assert.match(await run({ installed: false }), /not installed.*Nodes page/);
  assert.match(await run({ nodes: ["KSampler"] }), /lacks its own nodes CheckpointLoaderSimple/);
  assert.match(await run({ checkpoints: ["ace_step.safetensors"] }), /no picture checkpoint/);
  // Without the fix nodes the seam stays, and the answer says so.
  assert.match(await run({ nodes: ALL_NODES.slice(0, 6) }), /faint seam.*lacks the nodes to fix it/);
  assert.equal(pbrTools({ assets: await store() }).length, 0, "no ComfyUI and no image model: no tools");
});

test("make_ui_sprite: generate, remove the background, a cut-out to import; says so when the remover is missing", async () => {
  const assets = await store();
  const made = await assets.save(png(false), "image/png");
  const prompts: string[] = [];
  const generate: AgentTool = { risk: "safe", spec: { name: "generate_image", description: "", inputSchema: {} }, run: async (i) => (prompts.push(String(i.prompt)), { output: "ok", assetIds: [made.id] }) };
  let ready = true;
  const tool = pbrTools({ assets, generate, removeBackground: () => ({ ready: () => ready, remove: async () => Buffer.from(png(true, 8, 8)) }) })[0]!;
  assert.equal(tool.spec.name, "make_ui_sprite");
  const out = await tool.run({ prompt: "gold coin icon" }, context().ctx);
  assert.match(prompts[0]!, /^gold coin icon, single centered object, isolated on a plain white background/);
  const id = out.assetIds![0]!;
  assert.notEqual(id, made.id);
  assert.equal((await assets.get(id))?.asset.meta?.from, made.id);
  assert.match(out.output, new RegExp(`unity_import_sprite with file ${id}`));
  ready = false;
  const raw = await tool.run({ prompt: "gold coin icon" }, context().ctx);
  assert.deepEqual(raw.assetIds, [made.id]);
  assert.match(raw.output, /background remover is not set up/);
});

test("Apply to selected in Unity: the button's call passes the checks and makes a material on the selection (fake Unity)", async () => {
  const { comfy } = fakeComfy({ seam: false });
  const assets = await store();
  const out = await pbrTools({ comfy, assets })[0]!.run({ prompt: "rusty metal" }, context().ctx);
  const [, albedo, normal, roughness, ao] = /albedo=(\S+) normal=(\S+) roughness=(\S+) ao=(\S+)/.exec(out.output)!;
  const input = { name: "Rusty Metal", maps: { albedo, normal, roughness, ao }, apply_to: ["selection"] };
  assert.equal(quickActionProblem("unity_create_pbr_material", input), undefined);
  assert.match(quickActionProblem("unity_create_pbr_material", { ...input, apply_to: ["#-5"] })!, /selected objects/);
  assert.match(quickActionProblem("unity_create_pbr_material", { ...input, maps: { albedo: "C:/x.png" } })!, /library picture ids/);
  assert.equal(quickActionProblem("make_pbr_texture", { prompt: "rusty metal", count: 4 }), undefined);
  assert.match(quickActionProblem("make_pbr_texture", { prompt: " " })!, /prompt/);

  const root = await mkdtemp(join(tmpdir(), "kesher-pbr-unity-"));
  const project = join(root, "Game");
  await mkdir(join(project, "Assets"), { recursive: true });
  const cs: string[] = [];
  const u = new UnityCli({ projects: [project], active: project }, async () => undefined, async (args) => {
    cs.push(args.at(-1)!);
    return { code: 0, stdout: JSON.stringify({ success: true, result: "Made Assets/Generated/Rusty Metal/Rusty Metal.mat" }), stderr: "" };
  });
  const read = async (id: string) => { const g = await assets.get(id); return g ? { data: g.data, mimeType: g.asset.mimeType } : undefined; };
  const tool = unityTools(u, join(root, "out"), async () => "a", () => [], read).find((t) => t.spec.name === "unity_create_pbr_material")!;
  assert.equal(tool.askFirst!(input), "Changes the selected objects in the Unity scene.", "asked first");
  const made = await tool.run(input, { signal: new AbortController().signal, recordChange: () => undefined });
  assert.match(made.output, /Copied Assets\/Generated\/Rusty Metal\/Rusty Metal_albedo\.png, .*Rusty Metal_ao\.png\./);
  const code = cs.at(-1)!;
  assert.match(code, /Tex\("Assets\/Generated\/Rusty Metal\/Rusty Metal_normal\.png", 1\)/, "the normal map imported as a normal map");
  assert.match(code, /Tex\("Assets\/Generated\/Rusty Metal\/Rusty Metal_roughness\.png", 2\)/, "data maps linear (sRGB off)");
  assert.match(code, /Universal Render Pipeline\/Lit[\s\S]*"Standard"/);
  assert.match(code, /Selection\.gameObjects[\s\S]*IncrementCurrentGroup[\s\S]*CollapseUndoOperations/, "one Undo group");
});

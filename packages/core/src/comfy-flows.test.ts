import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DownloadManager } from "@kesher/downloads";
import { flowState, readyFlows, withCheckpoints } from "./comfy-flows.js";

test("every ready-made flow is wired: links point at nodes that exist, and it ends in a save node", () => {
  for (const f of readyFlows()) {
    for (const [id, node] of Object.entries(f.flow)) {
      for (const v of Object.values(node.inputs)) {
        if (Array.isArray(v)) assert.ok(f.flow[String(v[0])], `${f.id}: node ${id} links to missing ${String(v[0])}`);
      }
    }
    assert.ok(Object.values(f.flow).some((n) => /^Save/.test(n.class_type)), `${f.id} saves its result`);
    for (const id of Object.keys(f.checkpoints)) assert.ok(f.flow[id]?.inputs.ckpt_name, `${f.id}: ${id} is a loader`);
    assert.ok(f.files.length && f.license.url.startsWith("https://"));
  }
});

test("withCheckpoints uses ComfyUI's own name for the file, on Windows too", () => {
  const music = readyFlows().find((f) => f.id === "music-ace-step")!;
  assert.equal(withCheckpoints(music, ["other.safetensors", "music\\ace_step_v1_3.5b.safetensors"])["1"]!.inputs.ckpt_name, "music\\ace_step_v1_3.5b.safetensors");
  assert.equal(withCheckpoints(music, [])["1"]!.inputs.ckpt_name, "ace_step_v1_3.5b.safetensors");
  assert.equal(music.flow["1"]!.inputs.ckpt_name, "ace_step_v1_3.5b.safetensors", "the original is not changed");
});

test("flowState sees downloaded files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "flows-"));
  const flow = readyFlows().find((f) => f.id === "3d-hunyuan3d")!;
  const dm = new DownloadManager();
  assert.equal(flowState(flow, dir, dm).ready, false);
  assert.ok(flowState(flow, dir, dm).missingGb > 0);
  await mkdir(join(dir, "3d"));
  await writeFile(join(dir, "3d", "hunyuan3d-dit-v2.safetensors"), "x");
  assert.deepEqual(flowState(flow, dir, dm), { ready: true, downloading: false, missingGb: 0 });
});

test("ACE-Step 1.5's flow matches ComfyUI's node (every input it needs) and its template's settings", () => {
  const f = readyFlows().find((x) => x.id === "music-ace-step-15")!;
  const enc = f.flow["2"]!;
  assert.equal(enc.class_type, "TextEncodeAceStepAudio1.5");
  // The inputs of comfy_extras/nodes_ace.py TextEncodeAceStepAudio15 (a missing one fails the whole run).
  for (const k of ["clip", "tags", "lyrics", "seed", "bpm", "duration", "timesignature", "language", "keyscale", "generate_audio_codes", "cfg_scale", "temperature", "top_p", "top_k", "min_p"]) assert.ok(k in enc.inputs, k);
  assert.equal(f.flow["4"]!.class_type, "EmptyAceStep1.5LatentAudio");
  assert.deepEqual([f.flow["8"]!.inputs.steps, f.flow["8"]!.inputs.cfg, f.flow["5"]!.inputs.shift], [8, 1, 3]);
  assert.equal(readyFlows()[0]!.id, "music-ace-step-15", "the newer one comes first on the Nodes page");
});

test("the XL flow's loaders get ComfyUI's own names from each folder (sub-folders, Windows separators)", async () => {
  const { folderNames } = await import("./comfy-flows.js");
  const xl = readyFlows().find((f) => f.id === "music-ace-step-15-xl")!;
  const lists: Record<string, string[]> = { diffusion_models: ["music\\acestep_v1.5_xl_turbo_bf16.safetensors", "wan.safetensors"], text_encoders: ["qwen_0.6b_ace15.safetensors", "qwen_4b_ace15.safetensors"], vae: ["ace_1.5_vae.safetensors"] };
  const asked: string[] = [];
  const names = await folderNames(xl, async (f) => (asked.push(f), lists[f] ?? []));
  assert.deepEqual(asked.sort(), ["diffusion_models", "text_encoders", "vae"]);
  const g = withCheckpoints(xl, [], names);
  assert.equal(g["1"]!.inputs.unet_name, "music\\acestep_v1.5_xl_turbo_bf16.safetensors");
  assert.equal(g["11"]!.inputs.clip_name2, "qwen_4b_ace15.safetensors");
  assert.deepEqual(g["9"]!.inputs.vae, ["12", 0]);
  // Every file it downloads lands in a folder ComfyUI reads for that loader (comfy-manager's extra_model_paths).
  const base: Record<string, string> = { diffusion_models: "video/", text_encoders: "text_encoders/", vae: "vae/" };
  for (const n of xl.names!) assert.ok(xl.files.some((f) => f.rel.startsWith(base[n.folder]!) && f.rel.endsWith(n.file)), n.file);
});

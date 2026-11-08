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

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PartSegmenter } from "./part-seg.js";

test("the Space's requirements leave out PyTorch, Linux wheels, flash-attn, spconv (ours is for CUDA 12.4) and Gradio", () => {
  assert.deepEqual(PartSegmenter.requirements("torch==2.5.1\ntrimesh # meshes\nhttps://x/flash_attn-2.whl\nflash-attn\ngradio==4\nspconv-cu120\nfoo @ https://x/foo.whl\n-f https://idx\nfpsample\n"), ["trimesh", "fpsample"]);
});

test("not set up: it says so; a mesh must be a GLB", async () => {
  const s = new PartSegmenter(await mkdtemp(join(tmpdir(), "parts-")), async () => "uv");
  assert.equal(s.status().installed, false);
  await assert.rejects(s.segment(Buffer.from("glTF....................")), /Set up the parts engine/);
});

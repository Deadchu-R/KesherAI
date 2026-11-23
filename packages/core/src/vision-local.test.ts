import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LOCAL_VISION_ID } from "@kesher/shared";
import { findLocalVision, localVisionModel, pickLocalVision, visionCoordsOf } from "./vision-local.js";

test("visionCoordsOf: Qwen3-VL writes 0-1000, Qwen2/2.5-VL and UI-TARS write pixels, others are unknown", () => {
  assert.equal(visionCoordsOf("Qwen3VL-8B-Instruct-Q4_K_M.gguf"), "rel1000");
  assert.equal(visionCoordsOf("Qwen3-VL-8B-Instruct-UD-Q4_K_XL.gguf"), "rel1000");
  assert.equal(visionCoordsOf("Qwen2.5-VL-7B-Instruct-UD-Q4_K_XL.gguf"), "abs28");
  assert.equal(visionCoordsOf("Qwen2-VL-7B.gguf"), "abs28");
  assert.equal(visionCoordsOf("UI-TARS-1.5-7B-q4_k_m.gguf"), "abs28");
  assert.equal(visionCoordsOf("Qwen3-8B-Q4_K_M.gguf"), undefined);
  assert.equal(visionCoordsOf("gemma-3-12b-it.gguf"), undefined);
});

test("pickLocalVision: needs the projector in the same folder (F16 first); one without is listed apart", () => {
  const a = "/m/image-support/x/Qwen2.5-VL-7B-Instruct-GGUF";
  const b = "/m/chat/y/Qwen3-VL-8B-GGUF";
  const r = pickLocalVision([
    `${a}/Qwen2.5-VL-7B-Instruct-UD-Q4_K_XL.gguf`,
    `${b}/Qwen3-VL-8B-Instruct-Q4_K_M.gguf`,
    `${b}/mmproj-Qwen3-VL-8B-Instruct-Q8_0.gguf`,
    `${b}/mmproj-Qwen3-VL-8B-Instruct-F16.gguf`,
    `${b}/mmproj-Qwen3-VL-8B-Instruct-F16.gguf`,
    "/m/other/mmproj-Qwen2.5-VL.gguf",
    "/m/chat/z/llama-8b.gguf",
  ]);
  assert.deepEqual(r.noProjector, [`${a}/Qwen2.5-VL-7B-Instruct-UD-Q4_K_XL.gguf`]);
  assert.equal(r.usable.length, 1);
  assert.equal(r.usable[0]!.name, "Qwen3-VL-8B-Instruct-Q4_K_M");
  assert.equal(r.usable[0]!.files.mmproj, `${b}/mmproj-Qwen3-VL-8B-Instruct-F16.gguf`);
  assert.equal(r.usable[0]!.coords, "rel1000");
});

test("findLocalVision finds a Qwen2.5-VL file with its projector in an image-support folder", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "kesher-vlocal-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dir = join(root, "image-support", "someone", "Qwen2.5-VL-7B-Instruct-GGUF");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "Qwen2.5-VL-7B-Instruct-UD-Q4_K_XL.gguf"), "x");
  assert.equal(findLocalVision([root, join(root, "missing")]).usable.length, 0);
  await writeFile(join(dir, "mmproj-F16.gguf"), "x");
  const r = findLocalVision([root, root]);
  assert.equal(r.usable.length, 1);
  assert.equal(r.usable[0]!.coords, "abs28");
  const m = localVisionModel(r.usable[0]!);
  assert.equal(m.id, LOCAL_VISION_ID);
  assert.equal(m.coords, "abs28");
});

test("pickLocalVision: any model with a projector beside it can see; gemma-4-12b comes before Qwen2.5-VL and the 31B", () => {
  const f = (dir: string, model: string) => [`/m/chat/unsloth/${dir}/${model}`, `/m/chat/unsloth/${dir}/mmproj-F16.gguf`];
  const r = pickLocalVision([
    ...f("gemma-4-31B-it-GGUF", "gemma-4-31B-it-UD-Q4_K_XL.gguf"),
    ...f("Qwen2.5-VL-7B-Instruct-GGUF", "Qwen2.5-VL-7B-Instruct-UD-Q4_K_XL.gguf"),
    ...f("gemma-4-12b-it-GGUF", "gemma-4-12b-it-UD-Q4_K_XL.gguf"),
    "/m/chat/unsloth/plain/llama-8b.gguf",
  ]);
  assert.deepEqual(r.usable.map((m) => m.name), ["gemma-4-12b-it-UD-Q4_K_XL", "Qwen2.5-VL-7B-Instruct-UD-Q4_K_XL", "gemma-4-31B-it-UD-Q4_K_XL"]);
  assert.equal(r.usable[0]!.coords, "rel1000");
  assert.equal(r.usable[1]!.coords, "abs28");
  assert.deepEqual(r.noProjector, []);
});

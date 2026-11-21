import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { KesherServices } from "../services.js";
import { destinationFor, driveChoices, markFiles } from "./downloads.js";

const GB = 1024 ** 3;

test("drives: the heavy-data drive is offered (and default) for chat models only, by id", async () => {
  const root = await mkdtemp(join(tmpdir(), "kesher-drives-"));
  try {
    const models = join(root, "data", "models");
    const heavy = join(root, "heavy");
    const s = { paths: { models, root: join(root, "data") }, config: { heavyDir: heavy, comfyui: {} } } as unknown as KesherServices;
    const chat = await driveChoices(s, "Qwen3-8B-Q4_K_M.gguf");
    assert.deepEqual(chat.map((d) => [d.id, d.default]), [["heavy", true], ["models", false]]);
    assert.equal(chat[0]!.dir, join(heavy, "models"));
    assert.deepEqual((await driveChoices(s, "sdxl.safetensors")).map((d) => d.id), ["models"]);
    // Models already on the heavy drive: one choice.
    const inside = { ...s, paths: { ...s.paths, models: join(heavy, "models") } } as unknown as KesherServices;
    assert.deepEqual((await driveChoices(inside, "x.gguf")).map((d) => d.id), ["models"]);
    // No heavy folder set.
    const none = { ...s, config: { comfyui: {} } } as unknown as KesherServices;
    assert.deepEqual((await driveChoices(none, "x.gguf")).map((d) => d.id), ["models"]);
    // The chosen drive's folder is the root; a path cannot climb out of it.
    assert.equal(destinationFor(s, { repo: "org/r", path: "x.gguf", category: "chat" }, chat[0]!.dir), join(heavy, "models", "chat", "org/r", "x.gguf"));
    assert.throws(() => destinationFor(s, { repo: "org/r", path: "../../../../../x.gguf", category: "chat" }, chat[0]!.dir));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("file marks: quant, vision add-on, split parts counted together", () => {
  const hw = { platform: "linux" as const, cpu: "x", ramTotal: 32 * GB, ramFree: 16 * GB, unifiedMemory: false, gpus: [{ name: "RTX 4070", vramTotal: 12 * GB, vramFree: 11 * GB }] };
  const f = (path: string, gb: number) => ({ path, size: gb * GB, url: `https://hf/${path}` });
  const out = markFiles([f("README.md", 0), f("m-Q4_K_M.gguf", 4.9), f("big-Q8_0-00001-of-00002.gguf", 5), f("big-Q8_0-00002-of-00002.gguf", 5), f("mmproj-f16.gguf", 0.6)], hw, "image-text-to-text") as Array<Record<string, unknown>>;
  assert.equal(out[0]!.fit, undefined);
  assert.equal(out[1]!.quant, "Q4_K_M");
  assert.equal((out[1]!.fit as { fit: string }).fit, "gpu");
  assert.ok(out[1]!.estimate);
  // 10 GB across two parts does not fit 12 GB with context.
  assert.equal((out[2]!.fit as { fit: string }).fit, "partial");
  assert.equal(out[4]!.kind, "mmproj");
  assert.equal(out[4]!.estimate, undefined);
});

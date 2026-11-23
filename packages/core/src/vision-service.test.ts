import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VISION_MODELS } from "@kesher/shared";
import type { DownloadManager } from "@kesher/downloads";
import { VisionService, pickHubFile, savedName, visionServiceOf } from "./vision-service.js";

const file = (path: string, size = 1) => ({ path, size, url: `https://example.invalid/${path}` });

test("pickHubFile and savedName pick the catalog's files and save projectors as mmproj-….gguf", () => {
  const qwen = VISION_MODELS[0]!;
  const files = [file("Qwen3VL-8B-Instruct-F16.gguf"), file("Qwen3VL-8B-Instruct-Q4_K_M.gguf"), file("mmproj-Qwen3VL-8B-Instruct-Q8_0.gguf"), file("mmproj-Qwen3VL-8B-Instruct-F16.gguf")];
  assert.equal(pickHubFile(files, qwen.filePattern)?.path, "Qwen3VL-8B-Instruct-Q4_K_M.gguf");
  assert.equal(pickHubFile(files, qwen.mmprojPattern)?.path, "mmproj-Qwen3VL-8B-Instruct-F16.gguf");
  const tars = VISION_MODELS[1]!;
  const tf = [file("UI-TARS-1.5-7B-q4_k_s.gguf"), file("UI-TARS-1.5-7B-q4_k_m.gguf"), file("UI-TARS-1.5-7B-q8_0.mmproj")];
  assert.equal(pickHubFile(tf, tars.filePattern)?.path, "UI-TARS-1.5-7B-q4_k_m.gguf");
  assert.equal(pickHubFile(tf, tars.mmprojPattern)?.path, "UI-TARS-1.5-7B-q8_0.mmproj");
  assert.equal(savedName("UI-TARS-1.5-7B-q8_0.mmproj", true), "mmproj-UI-TARS-1.5-7B-q8_0.gguf");
  // A repository name never leaves the model's folder (security scan 169).
  assert.equal(savedName("..\\..\\AppData\\evil.gguf", false), "evil.gguf");
  assert.equal(savedName("sub/..", false), "model.gguf");
  assert.equal(savedName("a b:c.gguf", false), "a_b_c.gguf");
  assert.equal(savedName("sub/mmproj-x-F16.gguf", true), "mmproj-x-F16.gguf");
  assert.equal(savedName("sub/model.gguf", false), "model.gguf");
});

test("VisionService: heavy-data folder, installed files, its own slot with the projector, one picture request", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "kesher-vision-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = { heavyDir: join(root, "E"), computer: { visionModel: "auto" as const }, engines: {} };
  const loads: string[] = [];
  const stops: string[] = [];
  const v = new VisionService({
    paths: { models: join(root, "models"), root, engines: join(root, "engines") },
    config,
    downloads: {} as DownloadManager,
    binary: () => undefined,
    makeEngine: (port) => ({ baseUrl: `http://127.0.0.1:${port}`, apiKey: "k", load: async (p) => void loads.push(p), stop: async (why) => void stops.push(why ?? "") }),
  });
  assert.equal(v.dir(), join(root, "E", "gui-vision"));
  assert.equal(v.model(), undefined);
  assert.deepEqual(v.missing(), { installId: "vision-model", name: "Qwen3-VL 8B", sizeGb: 6.2, where: join(root, "E", "gui-vision") });
  const folder = join(v.dir(), "Qwen", "Qwen3-VL-8B-Instruct-GGUF");
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, "Qwen3VL-8B-Instruct-Q4_K_M.gguf"), "x");
  assert.deepEqual(await v.refresh(), [], "a model without its projector is not installed");
  await writeFile(join(folder, "mmproj-Qwen3VL-8B-Instruct-F16.gguf"), "x");
  assert.deepEqual(await v.refresh(), ["qwen3-vl-8b"]);
  assert.equal(v.model()?.id, "qwen3-vl-8b");

  const sent: Array<{ url: string; body: { messages: Array<{ content: unknown }>; logprobs: boolean } }> = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: { body: string }) => {
    sent.push({ url, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"point_2d": [100, 900]}' }, logprobs: { content: [{ token: "100", logprob: 0 }] } }] }));
  }) as typeof fetch;
  t.after(() => void (globalThis.fetch = realFetch));
  const r = await v.ground({ png: Buffer.from("png"), width: 1000, height: 500, query: "Save" });
  assert.deepEqual(r.found && [r.x, r.y, r.confidence], [100, 450, 1]);
  assert.equal(loads.length, 1);
  assert.match(loads[0]!, /Q4_K_M\.gguf$/);
  assert.match(sent[0]!.url, /\/v1\/chat\/completions$/);
  assert.equal(sent[0]!.body.logprobs, true);
  assert.match(JSON.stringify(sent[0]!.body.messages), /data:image\/png;base64,cG5n/);
  await v.ground({ png: Buffer.from("png"), width: 1000, height: 500, query: "Open" });
  assert.equal(loads.length, 1, "the slot stays loaded between calls");
  await v.unload();
  assert.deepEqual(stops, ["vision model unused"]);
  assert.equal(visionServiceOf(config), undefined);
  assert.equal(visionServiceOf(config, () => v), v);
  assert.equal(visionServiceOf(config), v);
});

test("VisionService: a Qwen2.5-VL file with its projector in the models folder is what \"auto\" uses; a chosen catalog model is not replaced by it", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "kesher-vision-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = { computer: { visionModel: "auto" as "auto" | "qwen3-vl-8b" }, engines: {} };
  const loads: string[] = [];
  const v = new VisionService({
    paths: { models: join(root, "models"), root, engines: join(root, "engines") },
    config,
    downloads: {} as DownloadManager,
    binary: () => undefined,
    makeEngine: (port) => ({ baseUrl: `http://127.0.0.1:${port}`, apiKey: "k", load: async (p) => void loads.push(p), stop: async () => undefined }),
  });
  const folder = join(root, "models", "image-support", "someone", "Qwen2.5-VL-7B-Instruct-GGUF");
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, "Qwen2.5-VL-7B-Instruct-UD-Q4_K_XL.gguf"), "x");
  await v.refresh();
  assert.equal(v.model(), undefined, "no projector: not usable");
  assert.equal(v.withoutProjector().length, 1);
  await writeFile(join(folder, "mmproj-F16.gguf"), "x");
  await v.refresh();
  assert.equal(v.model()?.name, "Qwen2.5-VL-7B-Instruct-UD-Q4_K_XL");
  assert.equal(v.model()?.coords, "abs28");
  assert.match(v.localFound()!.mmproj, /mmproj-F16\.gguf$/);
  config.computer.visionModel = "qwen3-vl-8b";
  assert.equal(v.model(), undefined, "a model chosen by name is only that model");
  config.computer.visionModel = "auto";
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ choices: [{ message: { content: "(280, 140)" } }] }))) as typeof fetch;
  t.after(() => void (globalThis.fetch = realFetch));
  await v.ground({ png: Buffer.from("png"), width: 1000, height: 500, query: "Save" });
  assert.match(loads[0]!, /Qwen2\.5-VL-7B-Instruct-UD-Q4_K_XL\.gguf$/);
  await v.unload();
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AssetStore } from "./assets.js";
import { quickActionNames, quickActionProblem, quickTool } from "./chat-quick-actions.js";

const ID = "0f8fad5b-d9cb-469f-a165-70867728950e";

test("only the listed tools run from a button, with sane inputs", () => {
  assert.equal(quickActionProblem("generate_image", { prompt: "a cat" }), undefined);
  assert.match(quickActionProblem("run_command", { command: "rm -rf /" })!, /cannot run from a button/);
  assert.match(quickActionProblem("upscale_image", { asset: "../../etc/passwd" })!, /asset id/);
  assert.equal(quickActionProblem("upscale_image", { asset: ID }), undefined);
  assert.match(quickActionProblem("unity_import_sprite", { file: "C:/Windows/x.png" })!, /asset id/);
  assert.match(quickActionProblem("generate_image", { prompt: "x".repeat(9000) })!, /too long/);
  assert.match(quickActionProblem("generate_image", [])!, /object/);
});

test("the buttons a chat shows: its own tools from the list and the services that are there", () => {
  assert.deepEqual(quickActionNames(["read_file", "generate_image", "unity_import_sprite"], {}), ["generate_image", "unity_import_sprite"]);
  assert.deepEqual(quickActionNames([], { upscale: async (b) => b, removeBackground: async (b) => b }), ["remove_background", "upscale_image"]);
});

test("Upscale makes a new picture and keeps the original; not set up says so", async () => {
  const assets = new AssetStore(await mkdtemp(join(tmpdir(), "kesher-quick-")));
  const png = Buffer.from("\x89PNG fake");
  const a = await assets.save(png, "image/png");
  const signal = new AbortController().signal;
  const ctx = { signal, recordChange: () => undefined };
  const up = quickTool("upscale_image", assets, { upscale: async (b) => Buffer.concat([b, b]), upscaleReady: async () => true })!;
  const out = await up.run({ asset: a.id }, ctx);
  assert.equal(out.assetIds?.length, 1);
  assert.notEqual(out.assetIds![0], a.id);
  assert.equal((await assets.get(out.assetIds![0]!))!.data.length, png.length * 2);
  assert.ok(await assets.get(a.id), "the original stays");
  const off = quickTool("upscale_image", assets, { upscale: async (b) => b, upscaleReady: async () => false })!;
  assert.match((await off.run({ asset: a.id }, ctx)).output, /not set up/);
  assert.equal(quickTool("remove_background", assets, {}), undefined, "no service, no tool");
  await assert.rejects(up.run({ asset: ID }, ctx), /not in KesherAI's library/);
});

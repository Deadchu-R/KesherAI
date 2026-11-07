import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, open, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { familyFor, pickSdAssets } from "./sdcpp.js";
import { createKesherServer } from "./server.js";

test("picks the stable-diffusion.cpp build and the model family", () => {
  const names = [
    "sd-master-2f88688-bin-win-cuda12-x64.zip",
    "sd-master-2f88688-bin-win-vulkan-x64.zip",
    "sd-master-2f88688-bin-win-avx2-x64.zip",
    "sd-master-2f88688-bin-Linux-Ubuntu-24.04-x86_64-vulkan.zip",
    "sd-master-2f88688-bin-Linux-Ubuntu-24.04-x86_64.zip",
    "sd-master-2f88688-bin-Darwin-macOS-26.6.2-arm64.zip",
  ];
  assert.deepEqual(pickSdAssets(names, { platform: "win32", arch: "x64", nvidia: true }), { engine: names[0] });
  assert.deepEqual(pickSdAssets(names, { platform: "win32", arch: "x64", nvidia: false }), { engine: names[1] });
  assert.deepEqual(pickSdAssets(names, { platform: "linux", arch: "x64", nvidia: false }), { engine: names[3] });
  assert.deepEqual(pickSdAssets(names, { platform: "darwin", arch: "arm64", nvidia: false }), { engine: names[5] });

  const q = familyFor("Qwen-Image-2.1-Turbo-Q4_K_M.gguf");
  assert.equal(q.id, "qwen-image");
  assert.equal(q.steps, 8, "turbo models need fewer steps");
  assert.equal(familyFor("flux1-schnell-Q4_0.gguf").steps, 4);
  assert.equal(familyFor("juggernautXL_v9.safetensors").id, "checkpoint");
});

test("downloaded image models show up under Images and generate through the built-in engine", async () => {
  const data = await mkdtemp(join(tmpdir(), "kesher-sd-"));
  const s = await createKesherServer({ dataDir: data, autodetect: false, pluginRoots: [] });
  try {
    // A model in models/image (from a text-to-image repo) and one in models/other (no tag on Hugging Face).
    for (const p of ["image/acme/SDXL-Lite/sdxl-lite.safetensors", "other/abenzerps/Qwen-Image-2.1-Turbo-GGUF/Qwen-Image-2.1-Turbo-Q4_K_M.gguf", "other/x/notes/readme-model.gguf"]) {
      const full = join(data, "models", p);
      await mkdir(join(full, ".."), { recursive: true });
      const fh = await open(full, "w");
      await fh.truncate(150 * 1024 ** 2);
      await fh.close();
    }
    const listing = (await s.app.inject({ method: "GET", url: "/api/models" })).json() as { models: Array<{ id: string; category: string }> };
    const images = listing.models.filter((m) => m.category === "image").map((m) => m.id).sort();
    assert.deepEqual(images, ["sdcpp/acme/SDXL-Lite/sdxl-lite.safetensors", "sdcpp/other/abenzerps/Qwen-Image-2.1-Turbo-GGUF/Qwen-Image-2.1-Turbo-Q4_K_M.gguf"]);

    // A stand-in sd-cli that writes a tiny PNG where -o says.
    const engineDir = join(data, "engines", "sdcpp", "test");
    await mkdir(engineDir, { recursive: true });
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAwS2OUAAAAABJRU5ErkJggg==";
    const fake = join(engineDir, process.platform === "win32" ? "sd-cli.exe" : "sd-cli");
    await writeFile(fake, `#!/bin/sh\nwhile [ "$1" != "" ]; do if [ "$1" = "-o" ]; then echo ${png} | base64 -d > "$2"; fi; echo "$1" >> "${join(data, "args.txt")}"; shift; done\n`);
    await chmod(fake, 0o755);
    if (process.platform === "win32") return; // the stand-in is a shell script

    const res = await s.app.inject({ method: "POST", url: "/api/images", payload: { modelId: "sdcpp/acme/SDXL-Lite/sdxl-lite.safetensors", prompt: "a cat", width: 512, height: 512, steps: 4 } });
    assert.equal(res.statusCode, 200, res.body);
    const { assets } = res.json() as { assets: Array<{ id: string; mimeType: string }> };
    assert.equal(assets[0]?.mimeType, "image/png");

    // Qwen-Image needs its VAE and text encoder first: the engine says it is getting ready instead of failing silently.
    const q = await s.app.inject({ method: "POST", url: "/api/images", payload: { modelId: "sdcpp/other/abenzerps/Qwen-Image-2.1-Turbo-GGUF/Qwen-Image-2.1-Turbo-Q4_K_M.gguf", prompt: "a cat", width: 512, height: 512, steps: 4 } });
    assert.match(q.body, /getting ready/);
  } finally {
    await s.close();
  }
});

test("reads progress from stable-diffusion.cpp output", async () => {
  const { progressFrom } = await import("./sdcpp.js");
  let p = progressFrom("ggml_cuda_init: found 1 CUDA devices", { phase: "loading", startedAt: 0 });
  assert.equal(p.device, "gpu");
  p = progressFrom("sampling using Euler method\r  |=====>      | 5/20 - 3.21s/it", p);
  assert.deepEqual([p.phase, p.step, p.steps, p.secondsPerStep], ["sampling", 5, 20, 3.21]);
  p = progressFrom("  |==========| 20/20 - 2.00it/s", p);
  assert.equal(p.secondsPerStep, 0.5);
});

test("LoRAs: downloads go to models/loras, are listed by name, and are not image models", async () => {
  const data = await mkdtemp(join(tmpdir(), "kesher-lora-"));
  const s = await createKesherServer({ dataDir: data, autodetect: false, pluginRoots: [] });
  try {
    const { destinationFor } = await import("./routes/downloads.js");
    const dest = destinationFor(s.services, { repo: "acme/pixel-art-lora", path: "pixel.safetensors", category: "image" });
    assert.equal(dest, join(s.services.paths.models, "loras", "pixel.safetensors"));
    await mkdir(join(dest, ".."), { recursive: true });
    const fh = await open(dest, "w");
    await fh.truncate(150 * 1024 ** 2);
    await fh.close();
    const r = (await s.app.inject({ method: "GET", url: "/api/loras" })).json() as { loras: Array<{ name: string }> };
    assert.deepEqual(r.loras.map((l) => l.name), ["pixel"]);
    const listing = (await s.app.inject({ method: "GET", url: "/api/models" })).json() as { models: Array<{ id: string; category: string }> };
    assert.ok(!listing.models.some((m) => m.category === "image" && m.id.includes("pixel")));
    assert.equal((await s.app.inject({ method: "DELETE", url: "/api/loras/pixel" })).statusCode, 200);
    assert.equal(((await s.app.inject({ method: "GET", url: "/api/loras" })).json() as { loras: unknown[] }).loras.length, 0);
  } finally {
    await s.app.close();
  }
});

test("upscale route: asks for a PNG, and for setup before the upscaler is downloaded", async () => {
  const data = await mkdtemp(join(tmpdir(), "kesher-up-"));
  const s = await createKesherServer({ dataDir: data, autodetect: false, pluginRoots: [] });
  try {
    const status = (await s.app.inject({ method: "GET", url: "/api/images/upscale" })).json() as { ready: boolean; modelMb: number };
    assert.equal(status.ready, false);
    assert.ok(status.modelMb > 0);
    const bad = await s.app.inject({ method: "POST", url: "/api/images/upscale", headers: { "content-type": "image/png" }, payload: Buffer.from("not a png at all") });
    assert.equal(bad.statusCode, 400);
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]);
    const res = await s.app.inject({ method: "POST", url: "/api/images/upscale", headers: { "content-type": "image/png" }, payload: png });
    assert.equal(res.statusCode, 409);
    assert.equal((res.json() as { code: string }).code, "needs-setup");
  } finally {
    await s.app.close();
  }
});

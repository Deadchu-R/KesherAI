import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, open, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanComputer } from "./model-scan.js";
import { createKesherServer } from "./server.js";

/** Writes a sparse file of `mb` megabytes starting with `head`. */
async function fakeModel(path: string, mb: number, head = "GGUF") {
  await mkdir(join(path, ".."), { recursive: true });
  const fh = await open(path, "w");
  await fh.write(head, 0);
  await fh.truncate(mb * 1024 ** 2);
  await fh.close();
}

test("scan finds LM Studio, Ollama and Hugging Face models without copying them", async () => {
  const home = await mkdtemp(join(tmpdir(), "kesher-scan-"));
  await fakeModel(join(home, ".lmstudio/models/lmstudio-community/Qwen3-8B-GGUF/Qwen3-8B-Q4_K_M.gguf"), 60);
  await fakeModel(join(home, ".lmstudio/models/lmstudio-community/Qwen3-8B-GGUF/mmproj-F16.gguf"), 60);
  await fakeModel(join(home, ".lmstudio/models/tiny/config.gguf"), 1);
  const blob = join(home, ".ollama/models/blobs/sha256-abc");
  await fakeModel(blob, 70);
  await mkdir(join(home, ".ollama/models/manifests/registry.ollama.ai/library/llama3.2"), { recursive: true });
  await writeFile(
    join(home, ".ollama/models/manifests/registry.ollama.ai/library/llama3.2/3b"),
    JSON.stringify({ layers: [{ mediaType: "application/vnd.ollama.image.model", digest: "sha256:abc" }] }),
  );
  await fakeModel(join(home, ".cache/huggingface/hub/models--black-forest-labs--FLUX.1-schnell/snapshots/123/flux1-schnell.safetensors"), 80, "{}");

  const r = await scanComputer([], home, {});
  const by = Object.fromEntries(r.map((f) => [f.source, f.models]));
  assert.deepEqual(by["LM Studio"]?.map((m) => m.name), ["Qwen3-8B-Q4_K_M.gguf"], "skips the vision projector and small files");
  assert.deepEqual(by["Ollama"]?.map((m) => [m.name, m.path, m.format]), [["llama3.2:3b", blob, "gguf"]]);
  assert.deepEqual(by["Hugging Face"]?.map((m) => [m.name, m.format]), [["black-forest-labs/FLUX.1-schnell · flux1-schnell.safetensors", "safetensors"]]);

  // Adding the Ollama folder makes its model loadable; a path elsewhere is refused.
  const s = await createKesherServer({ dataDir: await mkdtemp(join(tmpdir(), "kesher-sd-")), autodetect: false, pluginRoots: [] });
  try {
    const put = await s.app.inject({ method: "PUT", url: "/api/models/folders", payload: { folders: [{ folder: join(home, ".ollama/models"), source: "Ollama" }] } });
    assert.equal(put.statusCode, 200);
    const local = (await s.app.inject({ method: "GET", url: "/api/models/local" })).json() as Array<{ name: string; source: string; gguf: boolean }>;
    assert.deepEqual(local.map((m) => [m.name, m.source, m.gguf]), [["llama3.2:3b", "Ollama", true]]);
    const outside = await s.app.inject({ method: "POST", url: "/api/engines/llamacpp/load", payload: { modelPath: join(home, ".lmstudio/models/lmstudio-community/Qwen3-8B-GGUF/Qwen3-8B-Q4_K_M.gguf") } });
    assert.equal(outside.statusCode, 400);
    const remote = await s.app.inject({ method: "POST", url: "/api/models/scan", remoteAddress: "192.168.1.5", headers: { authorization: `Bearer ${s.services.config.remote.token}` } });
    assert.equal(remote.statusCode, 403);

    const dir = await mkdtemp(join(tmpdir(), "kesher-md-"));
    const moved = (await s.app.inject({ method: "PUT", url: "/api/models/folders", payload: { modelsDir: dir } })).json() as { modelsDir: string };
    assert.equal(moved.modelsDir, dir);
    assert.equal(s.services.config.modelsDir, dir);
  } finally {
    await s.close();
  }
});

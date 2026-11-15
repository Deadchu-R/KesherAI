import assert from "node:assert/strict";
import { test } from "node:test";
import { joinSplitModels } from "./routes/models.js";

test("a model in several files is one row with the whole size; missing parts are counted", () => {
  const f = (path: string, size: number) => ({ path, name: path.split("/").pop()!, size });
  const out = joinSplitModels([f("/m/a.gguf", 5), f("/m/big-00002-of-00004.gguf", 49), f("/m/big-00001-of-00004.gguf", 1), f("/m/big-00003-of-00004.gguf", 49), f("/m/big-00004-of-00004.gguf", 4), f("/m/half-00001-of-00003.gguf", 1)]);
  assert.deepEqual(out.map((x) => [x.path, x.name, x.size, x.parts]), [
    ["/m/a.gguf", "a.gguf", 5, undefined],
    ["/m/big-00001-of-00004.gguf", "big.gguf", 103, { have: 4, of: 4 }],
    ["/m/half-00001-of-00003.gguf", "half.gguf", 1, { have: 1, of: 3 }],
  ]);
});

test("a split model's speed estimate is for all its parts, not the small first part", async () => {
  const { mkdtemp, mkdir, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { createKesherServer } = await import("./server.js");
  const { estimatePerformance, detectHardwareCached } = await import("@kesher/downloads");
  const dataDir = await mkdtemp(join(tmpdir(), "kesher-split-est-"));
  const server = await createKesherServer({ dataDir, autodetect: false, pluginRoots: [] });
  try {
    const dir = join(server.services.paths.models, "chat");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "big-00001-of-00002.gguf"), Buffer.alloc(1_000));
    await writeFile(join(dir, "big-00002-of-00002.gguf"), Buffer.alloc(9_000_000));
    const list = (await server.app.inject({ method: "GET", url: "/api/models/local" })).json() as Array<{ size: number; parts?: unknown; estimate: { tokensPerSecond: number } }>;
    const big = list.find((m) => m.parts)!;
    assert.equal(big.size, 9_001_000);
    assert.equal(big.estimate.tokensPerSecond, estimatePerformance(9_001_000, await detectHardwareCached()).tokensPerSecond);
  } finally {
    await server.app.close();
  }
});

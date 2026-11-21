import assert from "node:assert/strict";
import { test } from "node:test";
import { budgetOf, estimateRepoFit, estimateRunFit, fileKind, kvCacheBytes, quantOf, splitGroup, type MemoryBudget, type ModelKind, type RunFit } from "./fit.js";
import { parseHubTree, toHubModel } from "./huggingface.js";

const GB = 1024 ** 3;
const pc = (vramGb: number, ramGb: number): MemoryBudget => ({ vram: vramGb * GB, ram: ramGb * GB, unified: false });

test("run marks: fully on the GPU, partly, too big", () => {
  const rows: Array<[string, number, MemoryBudget, ModelKind, RunFit]> = [
    ["8B Q4 on a 12 GB card", 4.9, pc(12, 32), "llm", "gpu"],
    ["8B Q4 on an 8 GB card", 4.9, pc(8, 16), "llm", "gpu"],
    ["14B Q4 on an 8 GB card spills", 8.9, pc(8, 32), "llm", "partial"],
    ["70B Q4 on 12 GB + 32 GB", 42, pc(12, 32), "llm", "too-big"],
    ["70B Q4 on 24 GB + 64 GB", 42, pc(24, 64), "llm", "partial"],
    ["no graphics card: in system memory", 4.9, pc(0, 32), "llm", "partial"],
    ["built-in graphics count as none", 4.9, budgetOf({ ramTotal: 16 * GB, unifiedMemory: false, gpus: [{ name: "UHD", vramTotal: 1 * GB, vramFree: GB }] }), "llm", "partial"],
    ["FLUX dev FP8 on a 12 GB card spills", 11.9, pc(12, 32), "diffusion", "partial"],
    ["SDXL on a 12 GB card", 6.9, pc(12, 32), "diffusion", "gpu"],
    ["Whisper large on a 6 GB card", 3.1, pc(6, 16), "audio", "gpu"],
    ["mmproj is small", 0.9, pc(4, 8), "mmproj", "gpu"],
    ["Mac 32 GB unified: 14B fits", 8.9, budgetOf({ ramTotal: 32 * GB, unifiedMemory: true, gpus: [] }), "llm", "gpu"],
    ["Mac 16 GB unified: 32B too big", 19.8, budgetOf({ ramTotal: 16 * GB, unifiedMemory: true, gpus: [] }), "llm", "too-big"],
  ];
  for (const [name, gb, budget, kind, want] of rows) assert.equal(estimateRunFit(gb * GB, budget, { kind }).fit, want, name);
});

test("a longer context needs more memory and can push a model off the GPU", () => {
  const b = pc(8, 32);
  assert.equal(estimateRunFit(4.9 * GB, b, { billions: 8, contextTokens: 8192 }).fit, "gpu");
  assert.equal(estimateRunFit(4.9 * GB, b, { billions: 8, contextTokens: 32768 }).fit, "partial");
  assert.ok(estimateRunFit(4.9 * GB, b, { billions: 8, contextTokens: 32768, kvBytes: 1 }).needBytes < estimateRunFit(4.9 * GB, b, { billions: 8, contextTokens: 32768 }).needBytes);
  // Llama 3 8B: 128 KB per token at f16.
  assert.ok(Math.abs(kvCacheBytes(8, 1) / 1024 - 128) < 2);
  assert.equal(estimateRunFit(0, b).fit, "unknown");
});

test("partial gives the share on the graphics card", () => {
  const r = estimateRunFit(8.9 * GB, pc(8, 32));
  assert.ok(r.gpuShare > 0.5 && r.gpuShare < 1, String(r.gpuShare));
});

test("repo marks from the Hub's parameter count, else the name", () => {
  const b = pc(12, 32);
  const rows: Array<[string, Parameters<typeof estimateRepoFit>[0], RunFit]> = [
    ["8B GGUF", { params: 8.2e9, gguf: true }, "gpu"],
    ["32B GGUF from the name", { parameters: "32B", gguf: true }, "partial"],
    ["8B BF16 safetensors", { params: 8e9, gguf: false, dtypeBytes: 2, pipelineTag: "text-generation" }, "partial"],
    ["FLUX 12B BF16 image spills (ComfyUI offloads)", { params: 12e9, gguf: false, dtypeBytes: 2, pipelineTag: "text-to-image" }, "partial"],
    ["32B BF16 safetensors", { params: 32e9, gguf: false, dtypeBytes: 2, pipelineTag: "text-generation" }, "too-big"],
    ["no size", { gguf: true }, "unknown"],
  ];
  for (const [name, m, want] of rows) assert.equal(estimateRepoFit(m, b).fit, want, name);
});

test("quant, kind and split parts from file names", () => {
  const quants: Array<[string, string | undefined]> = [
    ["Qwen3-8B-Q4_K_M.gguf", "Q4_K_M"], ["model.IQ3_XS.gguf", "IQ3_XS"], ["x-Q8_0.gguf", "Q8_0"], ["x-BF16.gguf", "BF16"],
    ["flux1-dev-fp8.safetensors", "FP8"], ["sub/Model-fp16.safetensors", "F16"], ["model.safetensors", undefined], ["Q4_K_M/x-Q4_K_M-00001-of-00002.gguf", "Q4_K_M"],
  ];
  for (const [path, want] of quants) assert.equal(quantOf(path), want, path);
  assert.equal(fileKind("mmproj-model-f16.gguf"), "mmproj");
  assert.equal(fileKind("Qwen3-8B-Q4_K_M.gguf", "text-generation"), "llm");
  assert.equal(fileKind("sdxl.safetensors", "text-to-image"), "diffusion");
  assert.equal(fileKind("model.safetensors", "automatic-speech-recognition"), "audio");
  assert.equal(splitGroup("x-Q4_K_M-00002-of-00003.gguf"), "x-Q4_K_M.gguf");
  assert.equal(splitGroup("x.gguf"), "x.gguf");
});

test("Hub search answer: parameter count, stored precision, context, licence", () => {
  const gguf = toHubModel({
    id: "Qwen/Qwen3-8B-GGUF", pipeline_tag: "text-generation", downloads: 1200, likes: 80, gated: false, library_name: "gguf",
    tags: ["gguf", "license:apache-2.0"], gguf: { total: 8_190_735_360, context_length: 40960, architecture: "qwen3" },
  });
  assert.equal(gguf.paramCount, 8_190_735_360);
  assert.equal(gguf.contextLength, 40960);
  assert.equal(gguf.dtypeBytes, undefined);
  assert.equal(gguf.license, "apache-2.0");
  assert.equal(gguf.parameters, "8B");
  assert.equal(gguf.category, "chat");
  const st = toHubModel({ id: "black-forest-labs/FLUX.1-schnell", pipeline_tag: "text-to-image", gated: "auto", cardData: { license: ["apache-2.0"] }, safetensors: { total: 12e9, parameters: { BF16: 11.9e9, F32: 1e8 } } });
  assert.equal(st.dtypeBytes, 2);
  assert.equal(st.paramCount, 12e9);
  assert.equal(st.gated, "auto");
  assert.equal(st.downloads, 0);
  const bare = toHubModel({ id: "someone/tiny" });
  assert.equal(bare.paramCount, undefined);
  assert.deepEqual(bare.tags, []);
});

test("Hub tree answer: LFS sizes, SHA-256, folders left out, URL-safe paths", () => {
  const files = parseHubTree("org/repo", "main", [
    { type: "directory", path: "Q4_K_M", size: 0 },
    { type: "file", path: "README.md", size: 1200 },
    { type: "file", path: "Q4_K_M/model #1.gguf", size: 135, lfs: { oid: "abc123", size: 4_900_000_000 } },
  ]);
  assert.equal(files.length, 2);
  assert.equal(files[1]!.size, 4_900_000_000);
  assert.equal(files[1]!.sha256, "abc123");
  assert.equal(files[1]!.url, "https://huggingface.co/org/repo/resolve/main/Q4_K_M/model%20%231.gguf");
  assert.equal(files[0]!.sha256, undefined);
});

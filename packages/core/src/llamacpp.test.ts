import { test } from "node:test";
import assert from "node:assert/strict";
import { LlamaEngine, pickLlamaAssets } from "./llamacpp.js";

// Real asset names from llama.cpp build b12110 (November 2026).
const ASSETS = [
  "cudart-llama-b12110-bin-ubuntu-cuda-12.8-x64.tar.gz",
  "cudart-llama-bin-win-cuda-12.4-x64.zip",
  "cudart-llama-bin-win-cuda-13.4-x64.zip",
  "llama-b12110-bin-macos-arm64.tar.gz",
  "llama-b12110-bin-macos-x64.tar.gz",
  "llama-b12110-bin-ubuntu-arm64.tar.gz",
  "llama-b12110-bin-ubuntu-cuda-12.8-x64.tar.gz",
  "llama-b12110-bin-ubuntu-cuda-13.4-x64.tar.gz",
  "llama-b12110-bin-ubuntu-vulkan-x64.tar.gz",
  "llama-b12110-bin-ubuntu-x64.tar.gz",
  "llama-b12110-bin-win-cpu-arm64.zip",
  "llama-b12110-bin-win-cpu-x64.zip",
  "llama-b12110-bin-win-cuda-12.4-x64.zip",
  "llama-b12110-bin-win-cuda-13.4-x64.zip",
  "llama-b12110-bin-win-vulkan-arm64.zip",
  "llama-b12110-bin-win-vulkan-x64.zip",
];

test("Windows with NVIDIA gets CUDA 12 plus its runtime", () => {
  assert.deepEqual(pickLlamaAssets(ASSETS, { platform: "win32", arch: "x64", nvidia: true }), {
    main: "llama-b12110-bin-win-cuda-12.4-x64.zip",
    runtime: "cudart-llama-bin-win-cuda-12.4-x64.zip",
    label: "Windows, NVIDIA CUDA 12.4",
  });
});

test("Windows without NVIDIA gets Vulkan; arm64 gets its own build", () => {
  assert.equal(pickLlamaAssets(ASSETS, { platform: "win32", arch: "x64", nvidia: false })?.main, "llama-b12110-bin-win-vulkan-x64.zip");
  assert.equal(pickLlamaAssets(ASSETS, { platform: "win32", arch: "arm64", nvidia: false })?.main, "llama-b12110-bin-win-vulkan-arm64.zip");
});

test("macOS and Linux", () => {
  assert.equal(pickLlamaAssets(ASSETS, { platform: "darwin", arch: "arm64", nvidia: false })?.main, "llama-b12110-bin-macos-arm64.tar.gz");
  const linux = pickLlamaAssets(ASSETS, { platform: "linux", arch: "x64", nvidia: true });
  assert.equal(linux?.main, "llama-b12110-bin-ubuntu-cuda-12.8-x64.tar.gz");
  assert.equal(linux?.runtime, "cudart-llama-b12110-bin-ubuntu-cuda-12.8-x64.tar.gz");
  assert.equal(pickLlamaAssets(ASSETS, { platform: "linux", arch: "x64", nvidia: false })?.main, "llama-b12110-bin-ubuntu-x64.tar.gz");
  assert.equal(pickLlamaAssets(ASSETS, { platform: "freebsd", arch: "x64", nvidia: false }), undefined);
});

test("server args always enable tool calling and a sane context", () => {
  assert.deepEqual(LlamaEngine.serverArgs(["-ngl", "99"]), ["-ngl", "99", "--jinja", "-c", "32768", "--cache-type-k", "q8_0", "--cache-type-v", "q8_0"]);
  assert.deepEqual(LlamaEngine.serverArgs(["-c", "8192", "--jinja"]), ["-c", "8192", "--jinja", "--cache-type-k", "q8_0", "--cache-type-v", "q8_0"]);
  assert.deepEqual(LlamaEngine.serverArgs([], false), ["-c", "32768", "--cache-type-k", "q8_0", "--cache-type-v", "q8_0"]);
  assert.deepEqual(LlamaEngine.serverArgs(["-ngl", "99"], true, 2), ["-ngl", "99", "--jinja", "-np", "2", "-c", "49152", "--cache-type-k", "q8_0", "--cache-type-v", "q8_0"]);
  assert.deepEqual(LlamaEngine.serverArgs(["-np", "4"], false, 2), ["-np", "4", "-c", "32768", "--cache-type-k", "q8_0", "--cache-type-v", "q8_0"]);
  assert.deepEqual(LlamaEngine.serverArgs(["-ctk", "f16"], false), ["-ctk", "f16", "-c", "32768"]);
  // Builds that fit: the context comes from the model and fit shrinks it to the free memory, at least 32K per chat.
  assert.deepEqual(LlamaEngine.serverArgs([], true, 2, true), ["--jinja", "-np", "2", "--fit-ctx", "32768", "--fit-target", "2048", "--cache-type-k", "q8_0", "--cache-type-v", "q8_0"]);
  assert.deepEqual(LlamaEngine.samplingArgs("C:/m/Qwen3.6-27B-UD-Q4_K_XL.gguf"), ["--temp", "0.6", "--top-p", "0.95", "--top-k", "20", "--min-p", "0"]);
  assert.deepEqual(LlamaEngine.samplingArgs("/m/Qwen3.6-27B.gguf", ["--temp", "1"]), ["--top-p", "0.95", "--top-k", "20", "--min-p", "0"]);
  assert.deepEqual(LlamaEngine.samplingArgs("/m/gemma-4.gguf"), []);
  assert.deepEqual(LlamaEngine.hybridArgs("/m/Qwen3.8-27B-UD-Q4_K_XL.gguf", [], "b12110"), ["--checkpoint-min-step", "1024"]);
  assert.deepEqual(LlamaEngine.hybridArgs("/m/Qwen3.8-27B.gguf", [], "b9000"), []);
  assert.deepEqual(LlamaEngine.hybridArgs("/m/Qwen3-Coder-30B.gguf", [], "b12110"), []);
  assert.deepEqual(LlamaEngine.samplingArgs("/m/Qwen3.8-27B-UD-Q4_K_XL.gguf").slice(0, 2), ["--temp", "1.0"]);
  assert.deepEqual(LlamaEngine.serverArgs(["-c", "65536"], true, 1, true), ["-c", "65536", "--jinja", "--cache-type-k", "q8_0", "--cache-type-v", "q8_0"]);
});

test("big models get longer to load than small ones", () => {
  assert.equal(LlamaEngine.loadTimeout(2 * 1024 ** 3), 300_000);
  assert.ok(LlamaEngine.loadTimeout(17.4 * 1024 ** 3) > 500_000);
});

test("a port another program listens on is seen as taken, and a free one is found", async () => {
  const { createServer } = await import("node:net");
  const { freePort, portTaken } = await import("./llamacpp.js");
  const srv = createServer();
  await new Promise<void>((r) => srv.listen({ host: "127.0.0.1", port: 0 }, r));
  const port = (srv.address() as { port: number }).port;
  assert.equal(await portTaken(port), true);
  const free = await freePort();
  assert.notEqual(free, port);
  assert.equal(await portTaken(free), false);
  await new Promise((r) => srv.close(r));
});

test("new builds fit the GPU layers themselves (the old -ngl 99 default is dropped); old builds keep -ngl 99", () => {
  assert.deepEqual(LlamaEngine.gpuArgs(["-ngl", "99"], "b12110"), []);
  assert.deepEqual(LlamaEngine.gpuArgs([], "b12110"), []);
  assert.deepEqual(LlamaEngine.gpuArgs(["-ngl", "40", "-c", "8192"], "b12110"), ["-ngl", "40", "-c", "8192"], "the user's own choice stays");
  assert.deepEqual(LlamaEngine.gpuArgs([], "b6500"), ["-ngl", "99"]);
  assert.deepEqual(LlamaEngine.gpuArgs(["-ngl", "99"], "b6500"), ["-ngl", "99"]);
});

test("the prompt-reading speed is read from llama-server's timing lines", () => {
  assert.equal(LlamaEngine.promptSpeed("3.25.293.298 I slot print_timing: id  0 | task 0 | prompt processing, n_tokens =   2048, progress = 0.35, t = 101.45 s / 20.19 tokens per second"), 20.2);
  assert.equal(LlamaEngine.promptSpeed("prompt eval time =    1234.56 ms /  5000 tokens (    0.25 ms per token,  4050.00 tokens per second)"), 4050);
  assert.equal(LlamaEngine.promptSpeed("       eval time =    500.00 ms /   100 tokens (    5.00 ms per token,   200.00 tokens per second)"), undefined);
});

test("Linux: AMD and Intel cards get Vulkan; NVIDIA without a CUDA build too; no Vulkan loader: CPU with a note", () => {
  const noCuda = ASSETS.filter((n) => !/cuda/.test(n));
  assert.equal(pickLlamaAssets(ASSETS, { platform: "linux", arch: "x64", nvidia: false, vulkan: true })?.main, "llama-b12110-bin-ubuntu-vulkan-x64.tar.gz");
  assert.equal(pickLlamaAssets(noCuda, { platform: "linux", arch: "x64", nvidia: true, vulkan: true })?.main, "llama-b12110-bin-ubuntu-vulkan-x64.tar.gz");
  const missing = pickLlamaAssets(ASSETS, { platform: "linux", arch: "x64", nvidia: false, vulkan: false, vulkanMissing: true });
  assert.equal(missing?.main, "llama-b12110-bin-ubuntu-x64.tar.gz");
  assert.match(missing!.label, /mesa-vulkan-drivers/);
  assert.equal(pickLlamaAssets(ASSETS, { platform: "linux", arch: "x64", nvidia: false })?.main, "llama-b12110-bin-ubuntu-x64.tar.gz");
});

test("Windows on Snapdragon: the Adreno build when there is one, else Vulkan arm64; never CUDA on arm64", () => {
  const withAdreno = [...ASSETS, "llama-b12110-bin-win-opencl-adreno-arm64.zip"];
  assert.equal(pickLlamaAssets(withAdreno, { platform: "win32", arch: "arm64", nvidia: false, cpu: "Snapdragon(R) X Elite" })?.main, "llama-b12110-bin-win-opencl-adreno-arm64.zip");
  assert.equal(pickLlamaAssets(ASSETS, { platform: "win32", arch: "arm64", nvidia: false, cpu: "Snapdragon(R) X Elite" })?.main, "llama-b12110-bin-win-vulkan-arm64.zip");
  assert.equal(pickLlamaAssets(ASSETS, { platform: "win32", arch: "arm64", nvidia: true })?.main, "llama-b12110-bin-win-vulkan-arm64.zip");
});

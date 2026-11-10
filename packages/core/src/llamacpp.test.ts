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
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildModelJobs, setupAllPlan, type ModelJobFacts } from "./model-jobs.js";
import { imagePickFor } from "./sdcpp.js";

const GB = 1024 ** 3;

/** A 24 GB card with 64 GB of memory and nothing set up. */
function facts(over: Partial<ModelJobFacts> = {}): ModelJobFacts {
  return {
    active: {},
    budget: { vram: 24 * GB, ram: 64 * GB, unified: false },
    hebrew: true,
    local: true,
    chatFiles: [],
    engineBusy: false,
    engineInstalled: true,
    image: { fileMissing: false, busy: false },
    video: { ready: false, busy: false, name: "Wan 2.1 text-to-video 1.3B", sizeGb: 7.2 },
    stt: { ready: false, busy: false, possible: true, label: "Whisper large-v3 turbo", sizeGb: 0.8 },
    tts: { ready: false, busy: false, sizeGb: 0.35 },
    embedding: { ready: false, busy: false, name: "Qwen3 Embedding 0.6B", sizeGb: 0.64 },
    translator: "main",
    vision: "auto",
    ...over,
  };
}
const job = (f: ModelJobFacts, id: string) => buildModelJobs(f, imagePickFor).find((j) => j.id === id)!;

test("no chat model and nothing on the computer: the best Start-here model for the card, to download", () => {
  const chat = job(facts(), "chat");
  assert.equal(chat.state, "none");
  assert.equal(chat.suggestion?.onComputer, false);
  assert.match(chat.suggestion!.setup, /^\/api\/models\/recommended\/[^/]+\/run$/);
  assert.ok(chat.suggestion!.sizeGb > 0);
  assert.equal(chat.suggestion!.fit, "gpu");
});

test("no chat model but one on the computer that fits the card: load it, nothing to download", () => {
  const f = facts({ chatFiles: [
    { path: "/m/chat/Qwen3.6-27B-Q4_K_M.gguf", name: "Qwen3.6-27B-Q4_K_M.gguf", size: 18 * GB },
    { path: "/m/chat/Qwen3-Coder-Next-Q4.gguf", name: "Qwen3-Coder-Next-Q4.gguf", size: 38 * GB },
    { path: "/m/chat/mmproj-F16.gguf", name: "mmproj-F16.gguf", size: 1 * GB },
  ] });
  const s = job(f, "chat").suggestion!;
  assert.equal(s.onComputer, true);
  assert.equal(s.sizeGb, 0);
  assert.equal(s.setup, "/api/engines/llamacpp/load");
  assert.deepEqual(s.body, { modelPath: "/m/chat/Qwen3.6-27B-Q4_K_M.gguf" });
});

test("a chosen chat file that is gone is missing; one that is there is ready", () => {
  const files = [{ path: "/m/chat/Qwen3.6-27B-Q4_K_M.gguf", name: "Qwen3.6-27B-Q4_K_M.gguf", size: 18 * GB }];
  assert.equal(job(facts({ active: { chat: "llamacpp/Gone-7B" }, chatFiles: files }), "chat").state, "missing");
  const ready = job(facts({ active: { chat: "llamacpp/Qwen3.6-27B-Q4_K_M" }, chatFiles: files }), "chat");
  assert.equal(ready.state, "ready");
  assert.equal(ready.suggestion, undefined);
  // A cloud model is never "missing" here.
  assert.equal(job(facts({ active: { chat: "opencode-go/mimo" } }), "chat").state, "ready");
});

test("while the engine is busy the chat row waits instead of offering a second setup", () => {
  const chat = job(facts({ engineBusy: true }), "chat");
  assert.equal(chat.state, "busy");
  assert.equal(chat.suggestion, undefined);
});

test("pictures: Qwen-Image on a big card, FLUX schnell on a small one", () => {
  assert.equal(job(facts(), "image").suggestion?.name, "Qwen-Image 2512");
  assert.equal(job(facts({ budget: { vram: 8 * GB, ram: 16 * GB, unified: false } }), "image").suggestion?.name, "FLUX.1 schnell");
  assert.equal(job(facts({ active: { image: "sdcpp/x/y.gguf" }, image: { fileMissing: true, busy: false } }), "image").state, "missing");
});

test("speech to text adds the Hebrew model for a Hebrew interface", () => {
  const s = job(facts(), "speech-to-text").suggestion!;
  assert.deepEqual(s.body, { hebrew: true });
  assert.equal(s.sizeGb, 2.4);
  assert.equal(job(facts({ hebrew: false }), "speech-to-text").suggestion!.sizeGb, 0.8);
});

test("embedding: a model already on the computer costs nothing; from the phone it cannot be set up", () => {
  const here = job(facts({ embedding: { ready: false, busy: false, name: "Qwen3 Embedding 0.6B", sizeGb: 0.64, onComputer: "Qwen3-Embedding-0.6B-Q8_0.gguf" } }), "embedding").suggestion!;
  assert.equal(here.onComputer, true);
  assert.equal(here.sizeGb, 0);
  assert.equal(job(facts({ local: false }), "embedding").suggestion!.canSetup, false);
});

test("music, 3D, translator and vision are chosen elsewhere, never downloaded from here", () => {
  for (const id of ["music", "3d", "translator", "vision"]) assert.equal(job(facts(), id).suggestion, undefined);
  assert.equal(job(facts({ active: { music: "comfyui/ace_step_1.5_turbo.safetensors" } }), "music").current, "ace_step_1.5_turbo");
});

test("set up everything: only what can be set up from here, chat first, with the total", () => {
  const all = setupAllPlan(buildModelJobs(facts({ local: false, engineInstalled: false }), imagePickFor));
  const ids = all.jobs.map((j) => j.id);
  assert.equal(ids[0], "chat");
  assert.ok(!ids.includes("embedding"), "computer-only from the phone");
  assert.ok(!ids.includes("router"), "needs the engine first");
  const sum = all.jobs.reduce((n, j) => n + j.suggestion!.sizeGb, 0);
  assert.equal(all.totalGb, Math.round(sum * 10) / 10);
  // Nothing missing: nothing to do.
  const ready = facts({ active: { chat: "opencode-go/x", image: "comfyui/a" }, routerFile: "Qwen3.5-2B-Q4_K_M.gguf", video: { ready: true, busy: false, name: "Wan", sizeGb: 7.2 }, stt: { ready: true, busy: false, possible: true, label: "w", sizeGb: 1 }, tts: { ready: true, busy: false, sizeGb: 0.3 }, embedding: { ready: true, busy: false, name: "e", sizeGb: 0.6 } });
  assert.deepEqual(setupAllPlan(buildModelJobs(ready, imagePickFor)), { jobs: [], totalGb: 0 });
});

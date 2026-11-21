import { test } from "node:test";
import assert from "node:assert/strict";
import type { ProviderRegistry } from "@kesher/providers";
import { AutoModel } from "./auto-model.js";
import type { HelperEngine } from "./chat-helpers.js";

const QWEN = "/models/chat/Qwen3.6-27B-Q4_K_M.gguf";
const DICTA = "/models/chat/DictaLM-3.0-24B-Q4_K_M.gguf";

/** A registry listing the loaded Qwen, a cloud Gemini, an image model and the beside model; an engine with three files. */
function setup(strengths: Record<string, Array<"tools" | "hebrew" | "code" | "research" | "vision" | "fast">> = {}) {
  let loaded = QWEN;
  const loads: string[] = [];
  const registry = {
    listAllModels: async () => ({
      models: [
        { id: "llamacpp/Qwen3.6-27B-Q4_K_M", providerId: "llamacpp", providerModelId: "x", name: "Qwen3.6-27B-Q4_K_M", category: "chat", location: "local" },
        { id: "google/gemini-flash-latest", providerId: "google", providerModelId: "x", name: "Gemini Flash", category: "chat", location: "cloud" },
        { id: "google/imagen-4", providerId: "google", providerModelId: "x", name: "Imagen 4", category: "chat", location: "cloud" },
        { id: "llamacpp-beside/Qwen3.5-2B-Q4_K_M", providerId: "llamacpp-beside", providerModelId: "x", name: "Qwen3.5-2B", category: "chat", location: "local" },
      ],
      errors: [],
    }),
  } as unknown as ProviderRegistry;
  const engine = {
    loaded: () => ({ running: true, path: loaded }),
    localModels: async () => [
      { path: QWEN, name: "Qwen3.6-27B-Q4_K_M.gguf", sizeGiB: 16.5 },
      { path: DICTA, name: "DictaLM-3.0-24B-Q4_K_M.gguf", sizeGiB: 14 },
      { path: "/models/chat/Qwen3.5-2B-Q4_K_M.gguf", name: "Qwen3.5-2B-Q4_K_M.gguf", sizeGiB: 1.3 },
    ],
    loadMain: async (path: string) => {
      loads.push(path);
      loaded = path;
      return `llamacpp/${path.split("/").pop()!.replace(/\.gguf$/, "")}`;
    },
  } as unknown as HelperEngine;
  const auto = new AutoModel({ registry: () => registry, engine: () => engine, settings: () => ({ strengths, cloudKinds: ["research"] }) });
  return { auto, loads };
}

test("models: the loaded model, the swappable files and the cloud; no image, beside or router models", async () => {
  const rows = await setup().auto.models();
  assert.deepEqual(rows.map((r) => [r.id, r.where, r.loaded]), [
    ["llamacpp/Qwen3.6-27B-Q4_K_M", "local", true],
    ["llamacpp/DictaLM-3.0-24B-Q4_K_M", "local", false],
    ["google/gemini-flash-latest", "cloud", true],
  ]);
  assert.deepEqual(rows[1]!.strengths, ["hebrew"]);
  assert.ok(rows[1]!.loadSec! > 0);
});

test("models: the user's strengths win over the family's", async () => {
  const rows = await setup({ "llamacpp/DictaLM-3.0-24B-Q4_K_M": ["hebrew", "fast"] }).auto.models();
  assert.deepEqual(rows.find((r) => r.id.includes("Dicta"))?.strengths, ["hebrew", "fast"]);
  assert.equal(rows.find((r) => r.id.includes("Dicta"))?.custom, true);
});

test("pick + load: a song's lyrics swap to DictaLM, the next turn of the task stays there", async () => {
  const { auto, loads } = setup();
  const msg = { groups: ["audio"], music: true, current: "llamacpp/Qwen3.6-27B-Q4_K_M", noCloud: false };
  const a = await auto.pick("c1", { ...msg, text: "תכתוב לי שיר על הים ותעשה ממנו שיר" });
  assert.equal(a.pick.modelId, "llamacpp/DictaLM-3.0-24B-Q4_K_M");
  assert.equal(a.pick.swap, true);
  assert.equal(await auto.load(a.row!.path!, "song"), "llamacpp/DictaLM-3.0-24B-Q4_K_M");
  assert.deepEqual(loads, [DICTA]);
  const b = await auto.pick("c1", { groups: [], current: "llamacpp/DictaLM-3.0-24B-Q4_K_M", noCloud: false, text: "תקצר קצת" });
  assert.deepEqual(b.pick, { modelId: "llamacpp/DictaLM-3.0-24B-Q4_K_M", why: "hebrew", swap: false });
  auto.forget("c1");
  const c = await auto.pick("c1", { groups: [], current: "llamacpp/DictaLM-3.0-24B-Q4_K_M", noCloud: false, text: "what do you think" });
  assert.equal(c.pick.why, "general");
});

test("Settings › Models › Auto: saved, checked, and a family's defaults put back", async () => {
  const { mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { createKesherServer } = await import("./server.js");
  const server = await createKesherServer({ dataDir: await mkdtemp(join(tmpdir(), "kesher-auto-")), autodetect: false, pluginRoots: [] });
  try {
    const put = (payload: unknown) => server.app.inject({ method: "PUT", url: "/api/model-router", payload: payload as Record<string, unknown> });
    const got = (await server.app.inject({ method: "GET", url: "/api/model-router" })).json() as { defaultAuto: boolean; cloudKinds: string[] };
    assert.deepEqual([got.defaultAuto, got.cloudKinds], [false, ["research"]]);
    assert.equal((await put({ defaultAuto: true, cloudKinds: ["research", "vision"] })).statusCode, 200);
    assert.equal((await put({ strengths: { modelId: "llamacpp/X", list: ["hebrew"] } })).json().strengths["llamacpp/X"][0], "hebrew");
    assert.equal((await put({ strengths: { modelId: "llamacpp/X", list: null } })).json().strengths["llamacpp/X"], undefined);
    assert.equal((await put({ cloudKinds: ["everything"] })).statusCode, 400);
    assert.equal((await put({ defaultAuto: "yes" })).statusCode, 400);
  } finally {
    await server.close();
  }
});

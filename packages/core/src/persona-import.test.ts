import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findPersonas, fromLmStudioPreset, fromOllamaLayers } from "./persona-import.js";

// The shape of a real preset on Roee's PC (.lmstudio/config-presets/short no reason.preset.json).
const PRESET = {
  identifier: "@local:short-no-reason",
  name: "short no reason",
  changed: false,
  operation: { fields: [
    { key: "llm.prediction.systemPrompt", value: "Always respond in Hebrew or English. Just provide the final answer directly." },
    { key: "llm.prediction.temperature", value: 0.3 },
    { key: "llm.prediction.topPSampling", value: { checked: true, value: 0.9 } },
  ] },
  load: { fields: [] },
};

test("an LM Studio preset becomes a persona with its prompt and settings; one without a prompt is skipped", () => {
  assert.deepEqual(fromLmStudioPreset(PRESET), { app: "LM Studio", name: "short no reason", instructions: "Always respond in Hebrew or English. Just provide the final answer directly.", params: { temperature: 0.3, topP: 0.9 } });
  assert.equal(fromLmStudioPreset({ name: "x", operation: { fields: [{ key: "llm.prediction.temperature", value: 1 }] } }), undefined);
});

test("an Ollama model made with a Modelfile becomes a persona (SYSTEM, PARAMETER, MESSAGE); a plain model does not", () => {
  const p = fromOllamaLayers("coder:latest", { system: "You write Unity C#.", params: JSON.stringify({ temperature: 0.2, stop: ["<|im_end|>"], num_ctx: 8192 }), messages: JSON.stringify([{ role: "user", content: "Make a rotator" }, { role: "assistant", content: "..." }]) });
  assert.deepEqual(p, { app: "Ollama", name: "coder:latest", instructions: "You write Unity C#.", params: { temperature: 0.2, stop: ["<|im_end|>"] }, starters: ["Make a rotator"] });
  assert.equal(fromOllamaLayers("llama3.2:3b", { params: "{}" }), undefined);
});

test("both are found on the computer from their own folders", async () => {
  const home = await mkdtemp(join(tmpdir(), "kesher-pimp-"));
  await mkdir(join(home, ".lmstudio", "config-presets"), { recursive: true });
  await writeFile(join(home, ".lmstudio", "config-presets", "short no reason.preset.json"), JSON.stringify(PRESET));
  const models = join(home, ".ollama", "models");
  await mkdir(join(models, "manifests", "registry.ollama.ai", "library", "coder"), { recursive: true });
  await mkdir(join(models, "blobs"), { recursive: true });
  await writeFile(join(models, "blobs", "sha256-sys"), "You write Unity C#.");
  await writeFile(join(models, "manifests", "registry.ollama.ai", "library", "coder", "latest"), JSON.stringify({ layers: [{ mediaType: "application/vnd.ollama.image.model", digest: "sha256:model" }, { mediaType: "application/vnd.ollama.image.system", digest: "sha256:sys" }] }));
  const found = await findPersonas(home, {});
  assert.deepEqual(found.map((f) => `${f.app}:${f.name}`).sort(), ["LM Studio:short no reason", "Ollama:coder:latest"]);
});

test("a LobeHub agent and Open WebUI's exported models become personas; other JSON is refused", async () => {
  const { personasFromFile } = await import("./persona-import.js");
  const lobe = personasFromFile({ identifier: "unity-guru", meta: { title: "Unity Guru", avatar: "🎮", tags: ["unity"] }, config: { systemRole: "You are a Unity expert.", params: { temperature: 0.4, top_p: 1 } } });
  assert.deepEqual(lobe, { source: "LobeHub", personas: [{ name: "Unity Guru", instructions: "You are a Unity expert.", params: { temperature: 0.4, topP: 1 }, icon: "🎮" }] });
  const owui = personasFromFile([{ id: "reviewer", name: "Reviewer", base_model_id: "qwen3", params: { system: "Review code.", temperature: 0.1, stop: ["###"] }, meta: { suggestion_prompts: [{ content: "Review this PR" }] } }]);
  assert.deepEqual(owui, { source: "Open WebUI", personas: [{ name: "Reviewer", instructions: "Review code.", params: { temperature: 0.1, stop: ["###"] }, starters: ["Review this PR"] }] });
  assert.equal(personasFromFile({ mapping: {} }), undefined);
  assert.equal(personasFromFile("text"), undefined);
});

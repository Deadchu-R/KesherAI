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

test("a character card (SillyTavern V2, and V1) becomes a persona; other JSON with a name does not", async () => {
  const { personasFromFile } = await import("./persona-import.js");
  const v2 = { spec: "chara_card_v2", spec_version: "2.0", data: { name: "Mira", description: "{{char}} is a ship's engineer who teases {{user}}.", personality: "dry, kind", scenario: "A long flight.", first_mes: "Oh, {{user}}. You again.", mes_example: "<START>\n{{char}}: Hand me that wrench.", system_prompt: "", alternate_greetings: ["Hey."] } };
  const r = personasFromFile(v2)!;
  assert.equal(r.source, "a character card");
  const p = r.personas[0]!;
  assert.equal(p.name, "Mira");
  assert.equal(p.icon, "🎭");
  assert.match(p.instructions, /^You are Mira\. Stay in character\./);
  assert.match(p.instructions, /Mira is a ship's engineer who teases the user\./);
  assert.match(p.instructions, /Personality: dry, kind[\s\S]*Scenario: A long flight\.[\s\S]*Mira: Hand me that wrench\.[\s\S]*open in this spirit:\nOh, the user\. You again\./);
  assert.doesNotMatch(p.instructions, /\{\{/);
  const v1 = personasFromFile({ name: "Bo", description: "A quiet fisherman.", personality: "calm", first_mes: "Morning." })!;
  assert.equal(v1.personas[0]!.name, "Bo");
  assert.equal(personasFromFile({ name: "just a thing", description: "not a card" }), undefined);
});

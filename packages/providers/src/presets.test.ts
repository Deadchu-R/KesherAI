import { test } from "node:test";
import assert from "node:assert/strict";
import { PROVIDER_PRESETS } from "./presets.js";

const risk = (id: string) => PROVIDER_PRESETS.find((p) => p.config.id === id)?.trainsOnData;

test("presets carry the shared training table", () => {
  assert.equal(risk("nvidia-nim"), "yes");
  assert.equal(risk("gemini"), "may");
  assert.equal(risk("mistral"), "may");
  assert.equal(risk("openrouter"), "some");
  assert.equal(risk("opencode-go"), "some");
  assert.equal(risk("ollama"), undefined);
  assert.equal(risk("anthropic"), undefined);
});

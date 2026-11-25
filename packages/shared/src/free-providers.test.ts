import { test } from "node:test";
import assert from "node:assert/strict";
import { freeModelsFor, inboxModelAllowed, isFreeOpencodeModel, isOpenrouterFreeModel, safeForTrainingProvider } from "./task-inbox.js";

test("OpenRouter: only :free ids and the free router are free; paid ids are refused in the inbox", () => {
  assert.equal(isOpenrouterFreeModel("openrouter/openrouter/free"), true);
  assert.equal(isOpenrouterFreeModel("openrouter/qwen/qwen3-coder:free"), true);
  assert.equal(isOpenrouterFreeModel("openrouter/openai/gpt-5"), false);
  assert.equal(isOpenrouterFreeModel("openrouter/qwen/qwen3-coder:free-evil"), false);
  assert.equal(inboxModelAllowed("openrouter/openai/gpt-5"), false);
  assert.equal(inboxModelAllowed("openrouter/qwen/qwen3-coder:free"), true);
});

test("guard: only each service's free model ids run; the training ones need the setting; chat-only services never", () => {
  assert.equal(inboxModelAllowed("zai/glm-4.7-flash"), true);
  assert.equal(inboxModelAllowed("zai/glm-5"), false);
  assert.equal(inboxModelAllowed("cloudflare-ai/@cf/qwen/qwen2.5-coder-32b-instruct"), true);
  assert.equal(inboxModelAllowed("gemini/gemini-2.5-pro", true), false);
  assert.equal(inboxModelAllowed("gemini/gemini-2.5-flash-lite", true), true);
  assert.equal(inboxModelAllowed("gemini/gemini-2.5-flash", false), false);
  assert.equal(inboxModelAllowed("mistral/devstral-small-latest", false), false);
  assert.equal(inboxModelAllowed("mistral/devstral-small-latest", true), true);
  assert.equal(inboxModelAllowed("opencode-go/iceman-contributor-free", false), false);
  assert.equal(inboxModelAllowed("opencode-go/iceman-contributor-free", true), true);
  assert.equal(inboxModelAllowed("opencode-go/mimo-v2.6-flash"), true);
  for (const p of ["sambanova", "cohere", "ollama-cloud"]) assert.equal(inboxModelAllowed(`${p}/x`, true), false);
  assert.equal(isFreeOpencodeModel("openrouter/openai/gpt-5"), false);
});

test("freeModelsFor: the order is Z.ai, OpenRouter, Cloudflare, then Gemini, Mistral, NVIDIA, contributor only when allowed", () => {
  const listed = {
    zai: ["zai/glm-4.5-flash", "zai/glm-4.7-flash"],
    openrouter: ["openrouter/meta/llama:free", "openrouter/qwen/qwen3-coder:free", "openrouter/openrouter/free", "openrouter/a/b"],
    "cloudflare-ai": ["cloudflare-ai/@cf/meta/llama-3", "cloudflare-ai/@cf/qwen/qwen2.5-coder-32b-instruct"],
    gemini: ["gemini/gemini-2.5-flash-lite", "gemini/gemini-2.5-pro", "gemini/gemini-2.5-flash"],
    mistral: ["mistral/mistral-large", "mistral/devstral-small-latest"],
    "nvidia-nim": ["nvidia-nim/qwen/qwen3-coder"],
    "opencode-go": ["opencode-go/beam-free", "opencode-go/iceman-contributor-free"],
  };
  assert.deepEqual(freeModelsFor(listed, false), ["zai/glm-4.7-flash", "openrouter/openrouter/free", "openrouter/qwen/qwen3-coder:free", "openrouter/meta/llama:free", "cloudflare-ai/@cf/qwen/qwen2.5-coder-32b-instruct"]);
  assert.deepEqual(freeModelsFor(listed, true).slice(5), ["gemini/gemini-2.5-flash", "gemini/gemini-2.5-flash-lite", "mistral/devstral-small-latest", "mistral/mistral-large", "nvidia-nim/qwen/qwen3-coder", "opencode-go/iceman-contributor-free"]);
  assert.deepEqual(freeModelsFor({}, true), []); // nothing connected, nothing listed
});

const safe = { kind: "code", risk: "low", size: "S", allowedPaths: ["apps/web/src/**"], title: "Add a clear button", goal: "Add a Clear all button to the list." };

test("safeForTrainingProvider: low-risk small code tasks away from security pass", () => {
  assert.equal(safeForTrainingProvider(safe).ok, true);
});

test("safeForTrainingProvider: risk, size, research, paths and words each keep a task off training services", () => {
  assert.equal(safeForTrainingProvider({ ...safe, risk: "medium" }).ok, false);
  assert.equal(safeForTrainingProvider({ ...safe, size: "M" }).ok, false);
  assert.equal(safeForTrainingProvider({ ...safe, kind: "research" }).ok, false);
  assert.equal(safeForTrainingProvider({ ...safe, allowedPaths: [] }).ok, false);
  assert.equal(safeForTrainingProvider({ ...safe, allowedPaths: ["**"] }).ok, false);
  for (const g of ["packages/core/src/auth.ts", "packages/core/src/relay-keys.ts", "packages/core/src/permissions.ts", "packages/core/src/control-reviewer.ts", "packages/core/src/hub-protocol.ts", "packages/core/src/updates/**", ".github/workflows/ci.yml", ".env.example", "apps/web/src/secrets.ts", "apps/desktop/installer/**"]) {
    assert.equal(safeForTrainingProvider({ ...safe, allowedPaths: [g] }).ok, false, g);
  }
  for (const w of ["Fix a vulnerability", "rotate the password", "Encrypt the file", "the API key", "check permissions", "CVE-2026-1234", "Security review"]) {
    assert.equal(safeForTrainingProvider({ ...safe, goal: w }).ok, false, w);
  }
  assert.equal(safeForTrainingProvider({ ...safe, title: "תיקון הרשאות" }).ok, false);
  assert.equal(safeForTrainingProvider({ ...safe, goal: "Fix the keyboard focus ring" }).ok, true);
});

test("the free cloud helpers' keys serve the inbox too, with the same free-only rules", () => {
  assert.equal(isFreeOpencodeModel("fc-openrouter/openrouter/free"), true);
  assert.equal(isFreeOpencodeModel("fc-openrouter/qwen/qwen3-coder:free"), true);
  assert.equal(isFreeOpencodeModel("fc-openrouter/anthropic/claude-opus-5-5"), false);
  assert.equal(isFreeOpencodeModel("fc-zhipu/glm-4.5-flash"), true);
  assert.equal(isFreeOpencodeModel("fc-zhipu/glm-5.3"), false);
  assert.equal(isFreeOpencodeModel("fc-cloudflare/@cf/qwen/qwen2.5-coder-32b-instruct"), true);
  assert.equal(inboxModelAllowed("fc-openrouter/anthropic/claude-opus-5-5", true), false);
});

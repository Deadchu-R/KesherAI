import { test } from "node:test";
import assert from "node:assert/strict";
import { OpenAICompatibleProvider, conversationKey } from "./openai-compatible.js";

test("conversationKey is stable per conversation and differs between conversations", () => {
  const a = [{ role: "system", content: "rules" }, { role: "user", content: "fix the bug" }];
  assert.equal(conversationKey(a), conversationKey([...a, { role: "assistant", content: "done" }]));
  assert.notEqual(conversationKey(a), conversationKey([a[0]!, { role: "user", content: "another task" }]));
  assert.match(conversationKey(a), /^kesher-[0-9a-f]{16}$/);
});

test("OpenCode endpoints get x-opencode-session and a KesherAI user agent; others do not", async () => {
  const seen: Array<Record<string, string>> = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (_u: unknown, init?: { headers?: Record<string, string> }) => {
    seen.push({ ...(init?.headers ?? {}) });
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    for (const baseUrl of ["https://opencode.ai/zen/go/v1", "https://api.openai.com/v1"]) {
      const p = new OpenAICompatibleProvider({ id: "x", type: "openai-compatible", baseUrl, apiKey: "k" });
      await p.chatWithTools({ providerModelId: "m", messages: [{ role: "user", content: "hi" }], tools: [] } as never).catch(() => undefined);
    }
  } finally {
    globalThis.fetch = real;
  }
  assert.match(seen[0]?.["x-opencode-session"] ?? "", /^kesher-/);
  assert.equal(seen[0]?.["user-agent"], "KesherAI/1.0");
  assert.equal(seen[1]?.["x-opencode-session"], undefined);
});

test("OpenRouter endpoints name the app (HTTP-Referer, X-Title); a connection's own headers win; others get neither", async () => {
  const seen: Array<Record<string, string>> = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (_u: unknown, init?: { headers?: Record<string, string> }) => {
    seen.push({ ...(init?.headers ?? {}) });
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const cfgs = [
      { baseUrl: "https://openrouter.ai/api/v1" },
      { baseUrl: "https://openrouter.ai/api/v1", options: { headers: { "X-Title": "Mine", "x-title": "Mine" } } },
      { baseUrl: "https://api.openai.com/v1" },
    ];
    for (const c of cfgs) {
      const p = new OpenAICompatibleProvider({ id: "x", type: "openai-compatible", apiKey: "k", ...c });
      await p.chatWithTools({ providerModelId: "m", messages: [{ role: "user", content: "hi" }], tools: [] } as never).catch(() => undefined);
    }
  } finally {
    globalThis.fetch = real;
  }
  assert.equal(seen[0]?.["x-title"], "KesherAI");
  assert.match(seen[0]?.["http-referer"] ?? "", /^https:\/\/github\.com\//);
  assert.equal(seen[0]?.["x-opencode-session"], undefined);
  assert.equal(seen[1]?.["x-title"], "Mine");
  assert.equal(seen[2]?.["x-title"], undefined);
});

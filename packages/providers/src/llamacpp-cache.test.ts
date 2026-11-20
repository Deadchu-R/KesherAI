import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { OpenAICompatibleProvider, llamaCppFields, readUsage } from "./openai-compatible.js";

/** Starts a server that records the last JSON body and answers with SSE lines. */
async function sseServer(lines: unknown[]) {
  let lastBody: Record<string, unknown> = {};
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    let raw = "";
    for await (const c of req) raw += c;
    lastBody = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const l of lines) res.write(`data: ${typeof l === "string" ? l : JSON.stringify(l)}\n\n`);
    res.end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as { port: number };
  return { url: `http://127.0.0.1:${port}`, body: () => lastBody, close: () => server.close() };
}

const done = [{ choices: [{ delta: { content: "hi" } }] }, "[DONE]"];

test("llamaCppFields: cache always, a slot per kind only with a slot for every kind", () => {
  assert.deepEqual(llamaCppFields("main", 1), { cache_prompt: true });
  assert.deepEqual(llamaCppFields("helper", 2), { cache_prompt: true });
  assert.deepEqual(llamaCppFields("main", 3), { cache_prompt: true, id_slot: 0 });
  assert.deepEqual(llamaCppFields("helper", 4), { cache_prompt: true, id_slot: 1 });
  assert.deepEqual(llamaCppFields(undefined, 3), { cache_prompt: true, id_slot: 2 });
});

test("llama.cpp provider sends cache_prompt and id_slot; other providers send neither", async () => {
  const srv = await sseServer(done);
  try {
    let slots = 4;
    const llama = new OpenAICompatibleProvider({ id: "llamacpp", type: "openai-compatible", baseUrl: srv.url, options: { llamaCpp: { slots: () => slots } } });
    await llama.chatWithTools!({ providerModelId: "m", messages: [{ role: "user", content: "x" }], tools: [], slotKind: "helper" });
    assert.equal(srv.body().cache_prompt, true);
    assert.equal(srv.body().id_slot, 1);
    slots = 1;
    await llama.chatWithTools!({ providerModelId: "m", messages: [{ role: "user", content: "x" }], tools: [], slotKind: "main" });
    assert.equal(srv.body().cache_prompt, true);
    assert.equal("id_slot" in srv.body(), false);
    for await (const _ of llama.chat({ providerModelId: "m", messages: [{ role: "user", content: "x" }] })) void _;
    assert.equal(srv.body().cache_prompt, true);

    const cloud = new OpenAICompatibleProvider({ id: "openai", type: "openai-compatible", baseUrl: srv.url });
    await cloud.chatWithTools!({ providerModelId: "m", messages: [{ role: "user", content: "x" }], tools: [], slotKind: "main" });
    assert.equal("cache_prompt" in srv.body(), false);
    assert.equal("id_slot" in srv.body(), false);
    for await (const _ of cloud.chat({ providerModelId: "m", messages: [{ role: "user", content: "x" }] })) void _;
    assert.equal("cache_prompt" in srv.body(), false);
  } finally {
    srv.close();
  }
});

test("readUsage: non-streaming answers (llama.cpp timings, OpenAI cached_tokens)", () => {
  assert.deepEqual(readUsage({ usage: { prompt_tokens: 1200, completion_tokens: 40 }, timings: { cache_n: 1000, prompt_n: 200, predicted_n: 40 } }), { inputTokens: 1200, outputTokens: 40, cachedTokens: 1000 });
  assert.deepEqual(readUsage({ usage: { prompt_tokens: 900, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 768 } } }), { inputTokens: 900, outputTokens: 5, cachedTokens: 768 });
  // No usage block: the whole prompt is the cached part plus the part read now.
  assert.deepEqual(readUsage({ timings: { cache_n: 300, prompt_n: 20, predicted_n: 7 } }), { inputTokens: 320, outputTokens: 7, cachedTokens: 300 });
  assert.deepEqual(readUsage({ usage: { prompt_tokens: 10, completion_tokens: 2 } }), { inputTokens: 10, outputTokens: 2 });
  assert.equal(readUsage({}), undefined);
});

test("readUsage: streaming, timings and usage in separate chunks", async () => {
  const srv = await sseServer([
    { choices: [{ delta: { content: "hi" } }] },
    { choices: [{ delta: {}, finish_reason: "stop" }], timings: { cache_n: 512, prompt_n: 64, predicted_n: 3 } },
    { choices: [], usage: { prompt_tokens: 576, completion_tokens: 3 } },
    "[DONE]",
  ]);
  try {
    const p = new OpenAICompatibleProvider({ id: "llamacpp", type: "openai-compatible", baseUrl: srv.url, options: { llamaCpp: {} } });
    const r = await p.chatWithTools!({ providerModelId: "m", messages: [{ role: "user", content: "x" }], tools: [] });
    assert.deepEqual(r.usage, { inputTokens: 576, outputTokens: 3, cachedTokens: 512 });
    let usage;
    for await (const ev of p.chat({ providerModelId: "m", messages: [{ role: "user", content: "x" }] })) if (ev.type === "done") usage = ev.usage;
    assert.deepEqual(usage, { inputTokens: 576, outputTokens: 3, cachedTokens: 512 });
  } finally {
    srv.close();
  }
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import type { ChatStreamEvent } from "@kesher/shared";
import { OpenAICompatibleProvider, THINKING_BUDGET_MESSAGE, withNoThink } from "./openai-compatible.js";
import { ThinkSplitter } from "./think-split.js";

/** A fake llama-server: records the request body and streams the given SSE chunks. */
async function fake(lines: unknown[]) {
  let body: Record<string, unknown> = {};
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    let raw = "";
    for await (const c of req) raw += c;
    body = JSON.parse(raw) as Record<string, unknown>;
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const l of lines) res.write(`data: ${typeof l === "string" ? l : JSON.stringify(l)}\n\n`);
    res.end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as { port: number };
  const llama = new OpenAICompatibleProvider({ id: "llamacpp", type: "openai-compatible", baseUrl: `http://127.0.0.1:${port}`, options: { llamaCpp: {} } });
  return { llama, body: () => body, close: () => server.close() };
}

const delta = (d: Record<string, unknown>, finish: string | null = null) => ({ choices: [{ delta: d, finish_reason: finish }] });
const collect = async (it: AsyncIterable<ChatStreamEvent>) => {
  const out: ChatStreamEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
};
const req = (extra: Record<string, unknown> = {}) => ({ providerModelId: "Qwen3.5-2B-Q4_K_M", messages: [{ role: "user" as const, content: "hi" }], ...extra });

test("chat: reasoning_content becomes reasoning events, content stays delta", async () => {
  const s = await fake([delta({ reasoning_content: "hmm " }), delta({ reasoning_content: "ok" }), delta({ content: "שלום" }), delta({}, "stop"), "[DONE]"]);
  try {
    const ev = await collect(s.llama.chat!(req()));
    assert.deepEqual(ev, [{ type: "reasoning", text: "hmm " }, { type: "reasoning", text: "ok" }, { type: "delta", text: "שלום" }, { type: "done" }]);
  } finally { s.close(); }
});

test("chat: an inline <think> block (split across chunks) is reasoning, not answer", async () => {
  const s = await fake([delta({ content: "<thi" }), delta({ content: "nk>plan</th" }), delta({ content: "ink>ans" }), delta({ content: "wer" }), "[DONE]"]);
  try {
    const ev = await collect(s.llama.chat!(req()));
    const text = ev.filter((e) => e.type === "delta").map((e) => (e as { text: string }).text).join("");
    const think = ev.filter((e) => e.type === "reasoning").map((e) => (e as { text: string }).text).join("");
    assert.equal(text, "answer");
    assert.equal(think, "plan");
  } finally { s.close(); }
});

test("chat: hitting max tokens while thinking ends with a clear error, not an empty answer", async () => {
  const s = await fake([delta({ reasoning_content: "still thinking" }), delta({}, "length"), "[DONE]"]);
  try {
    const ev = await collect(s.llama.chat!(req({ maxTokens: 5 })));
    assert.deepEqual(ev.at(-1), { type: "error", message: THINKING_BUDGET_MESSAGE });
    assert.equal(ev.some((e) => e.type === "done"), false);
  } finally { s.close(); }
});

test("chat: a short answer cut by max tokens (no thinking) is still a normal done", async () => {
  const s = await fake([delta({ content: "ab" }), delta({}, "length"), "[DONE]"]);
  try {
    assert.equal((await collect(s.llama.chat!(req()))).at(-1)?.type, "done");
  } finally { s.close(); }
});

test("chat: thinking off sends enable_thinking false; Nemotron also gets /no_think", async () => {
  const s = await fake([delta({ content: "ok" }), "[DONE]"]);
  try {
    await collect(s.llama.chat!(req({ thinking: "off" })));
    assert.deepEqual((s.body().chat_template_kwargs as { enable_thinking: boolean }).enable_thinking, false);
    await collect(s.llama.chat!(req({ providerModelId: "DictaLM-3.0-Nemotron-12B-Instruct-Q4_K_M", thinking: "off" })));
    assert.deepEqual((s.body().messages as Array<{ role: string; content: string }>)[0], { role: "system", content: "/no_think" });
    await collect(s.llama.chat!(req()));
    assert.equal("chat_template_kwargs" in s.body(), false);
  } finally { s.close(); }
});

test("chatWithTools: cut off while thinking throws the clear message; thinking text never reaches onText", async () => {
  const s = await fake([delta({ reasoning_content: "hmm" }), delta({}, "length"), "[DONE]"]);
  try {
    await assert.rejects(s.llama.chatWithTools!({ ...req(), tools: [] }), { message: THINKING_BUDGET_MESSAGE });
  } finally { s.close(); }
  const t = await fake([delta({ content: "<think>x</think>hi" }), "[DONE]"]);
  try {
    const seen: string[] = [];
    const r = await t.llama.chatWithTools!({ ...req(), tools: [] }, undefined, (d) => seen.push(d));
    assert.equal(r.text, "hi");
    assert.deepEqual(seen, ["hi"]);
  } finally { t.close(); }
});

test("withNoThink: only Nemotron on llama.cpp with thinking off; merges into an existing system message", () => {
  const msgs = [{ role: "system", content: "be brief" }, { role: "user", content: "x" }];
  assert.equal(withNoThink(msgs, "nemotron-nano", "high", true), msgs);
  assert.equal(withNoThink(msgs, "qwen3", "off", true), msgs);
  assert.equal(withNoThink(msgs, "nemotron-nano", "off", false), msgs);
  assert.equal(withNoThink(msgs, "nemotron-nano", "off", true)[0]!.content, "/no_think\nbe brief");
  const once = withNoThink(msgs, "nemotron-nano", "off", true);
  assert.equal(withNoThink(once, "nemotron-nano", "off", true), once);
});

test("ThinkSplitter: tag cut anywhere, started inside, unfinished tag flushed", () => {
  const sp = new ThinkSplitter(true);
  assert.deepEqual(sp.push("abc</th"), { text: "", reasoning: "abc" });
  assert.deepEqual(sp.push("ink>done<"), { text: "done", reasoning: "" });
  assert.deepEqual(sp.flush(), { text: "<", reasoning: "" });
});

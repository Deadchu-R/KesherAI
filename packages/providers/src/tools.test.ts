import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { OpenAICompatibleProvider, toOpenAIMessages } from "./openai-compatible.js";
import { AnthropicProvider, toAnthropicMessages } from "./anthropic.js";
import { parseToolArguments } from "./tool-args.js";
import type { AgentMessage } from "@kesher/shared";

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

const history: AgentMessage[] = [
  { role: "system", content: "Be brief." },
  { role: "user", content: "Read a.txt" },
  { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read_file", arguments: { path: "a.txt" } }] },
  { role: "tool", toolCallId: "c1", toolName: "read_file", content: "hello" },
];

test("OpenAI tool calls are assembled from streamed fragments", async () => {
  const srv = await sseServer([
    { choices: [{ delta: { content: "Let me " } }] },
    { choices: [{ delta: { content: "check." } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_9", function: { name: "write_file", arguments: '{"path":' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"b.txt","content":"x"}' } }] } }] },
    "[DONE]",
  ]);
  try {
    const p = new OpenAICompatibleProvider({ id: "t", type: "openai-compatible", baseUrl: `${srv.url}/v1` });
    const deltas: string[] = [];
    const out = await p.chatWithTools(
      { providerModelId: "m", messages: history, tools: [{ name: "write_file", description: "d", inputSchema: { type: "object" } }] },
      undefined,
      (d) => deltas.push(d),
    );
    assert.equal(out.text, "Let me check.");
    assert.deepEqual(deltas, ["Let me ", "check."]);
    assert.deepEqual(out.toolCalls, [{ id: "call_9", name: "write_file", arguments: { path: "b.txt", content: "x" } }]);
    const body = srv.body() as { tools: Array<{ type: string; function: { name: string } }>; messages: unknown[] };
    assert.equal(body.tools[0]?.function.name, "write_file");
    assert.deepEqual(body.messages[2], {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "c1", type: "function", function: { name: "read_file", arguments: '{"path":"a.txt"}' } }],
    });
    assert.deepEqual(body.messages[3], { role: "tool", tool_call_id: "c1", content: "hello" });
  } finally {
    srv.close();
  }
});

test("OpenAI requests without tools omit the tools field", () => {
  assert.deepEqual(toOpenAIMessages([{ role: "user", content: "hi" }]), [{ role: "user", content: "hi" }]);
});

test("Anthropic tool_use blocks and JSON deltas become tool calls", async () => {
  const srv = await sseServer([
    { type: "message_start", message: { usage: { input_tokens: 12 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "On it." } },
    { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "tu_1", name: "run_command" } },
    { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"command":"npm' } },
    { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: ' test"}' } },
    { type: "message_delta", usage: { output_tokens: 7 } },
    { type: "message_stop" },
  ]);
  try {
    const p = new AnthropicProvider({ id: "a", type: "anthropic", apiKey: "k", baseUrl: `${srv.url}/v1` });
    const out = await p.chatWithTools({ providerModelId: "claude", messages: history, tools: [] });
    assert.equal(out.text, "On it.");
    assert.deepEqual(out.toolCalls, [{ id: "tu_1", name: "run_command", arguments: { command: "npm test" } }]);
    assert.deepEqual(out.usage, { inputTokens: 12, outputTokens: 7 });
    const body = srv.body() as { system: string; tools?: unknown };
    assert.equal(body.system, "Be brief.");
    assert.equal(body.tools, undefined);
  } finally {
    srv.close();
  }
});

test("Anthropic conversion merges tool results into one user turn", () => {
  const { messages } = toAnthropicMessages([
    ...history,
    { role: "tool", toolCallId: "c2", toolName: "x", content: "" },
    { role: "user", content: "thanks" },
  ]);
  assert.deepEqual(messages.map((m) => m.role), ["user", "assistant", "user"]);
  assert.deepEqual(messages[2]?.content, [
    { type: "tool_result", tool_use_id: "c1", content: "hello" },
    { type: "tool_result", tool_use_id: "c2", content: "(no output)" },
    { type: "text", text: "thanks" },
  ]);
});

test("invalid tool JSON is kept, not thrown", () => {
  assert.deepEqual(parseToolArguments(""), {});
  assert.deepEqual(parseToolArguments('{"a":1}'), { a: 1 });
  assert.deepEqual(parseToolArguments("{oops"), { _invalidJson: "{oops" });
});

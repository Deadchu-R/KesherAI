import { test } from "node:test";
import assert from "node:assert/strict";
import { splitText, TelegramBridge, type TelegramConfig } from "./telegram.js";

function fake() {
  const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
  const http = (async (url: string, init: { body?: string }) => {
    const method = url.split("/").pop()!;
    const body = typeof init.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    calls.push({ method, body });
    const result = method === "getMe" ? { username: "my_kesher_bot" } : method === "getUpdates" ? [] : true;
    return new Response(JSON.stringify({ ok: true, result }));
  }) as unknown as typeof fetch;
  return { calls, http };
}

test("pairing needs the code; then messages reach a conversation and answers come back", async () => {
  const { calls, http } = fake();
  const config: TelegramConfig = { enabled: false, chats: [], conversations: {} };
  const sent: Array<[string, string]> = [];
  const decided: string[] = [];
  const bridge = new TelegramBridge(config, async () => undefined, {
    newConversation: async () => "conv-1",
    send: async (c, t) => void sent.push([c, t]),
    decide: async (_c, r, d) => (decided.push(`${r}:${d}`), true),
    answer: async () => true,
    image: async () => undefined,
  }, http);
  await assert.rejects(bridge.setToken("nope"));
  assert.equal(await bridge.setToken("123456789:AAbbccddeeffgghhiijjkkllmmnnooppqq"), "my_kesher_bot");
  bridge.stop();
  (bridge as unknown as { running: boolean }).running = true;

  const msg = (text: string, id = 42) => ({ update_id: 1, message: { chat: { id, type: "private" }, text } });
  await bridge.handle(msg("hello"));
  await bridge.handle(msg("/start 000000"));
  assert.equal(sent.length, 0, "an unpaired chat is ignored");
  assert.equal(calls.filter((c) => c.method === "sendMessage").length, 0, "and gets no answer");

  await bridge.handle(msg(`/start ${bridge.status().pairCode}`));
  assert.deepEqual(config.chats, [42]);
  await bridge.handle(msg("what is 2+2?"));
  assert.deepEqual(sent, [["conv-1", "what is 2+2?"]]);
  assert.equal(config.conversations["42"], "conv-1");

  bridge.onConversationEvent("conv-1", { type: "assistant", turn: 1, text: "4" } as never);
  bridge.onConversationEvent("conv-1", { type: "status", status: "idle" } as never);
  bridge.onConversationEvent("conv-1", { type: "approval_request", requestId: "r1", callId: "c", name: "run_command", input: {}, preview: "ls", reason: "Runs a command" } as never);
  await new Promise((r) => setTimeout(r, 10));
  const texts = calls.filter((c) => c.method === "sendMessage").map((c) => c.body.text as string);
  assert.ok(texts.includes("4"));
  const approval = calls.find((c) => c.method === "sendMessage" && String(c.body.text).startsWith("Needs your approval"))!;
  const [allow] = (approval.body.reply_markup as { inline_keyboard: Array<Array<{ callback_data: string }>> }).inline_keyboard[0]!;

  // Another chat cannot press it; the paired one can, once.
  await bridge.handle({ update_id: 2, callback_query: { id: "q0", data: allow!.callback_data, message: { chat: { id: 7 }, message_id: 1 } } });
  await bridge.handle({ update_id: 3, callback_query: { id: "q1", data: allow!.callback_data, message: { chat: { id: 42 }, message_id: 1 } } });
  await bridge.handle({ update_id: 4, callback_query: { id: "q2", data: allow!.callback_data, message: { chat: { id: 42 }, message_id: 1 } } });
  assert.deepEqual(decided, ["r1:allow"]);
});

test("splitText keeps messages under Telegram's limit", () => {
  const parts = splitText(`${"a ".repeat(3000)}\n\n${"b ".repeat(3000)}`, 4000);
  assert.ok(parts.length >= 2 && parts.every((p) => p.length <= 4000));
});

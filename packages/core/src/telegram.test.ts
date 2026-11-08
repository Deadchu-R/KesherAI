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
  const alerts: string[] = [];
  const bridge = new TelegramBridge(config, async () => undefined, {
    alert: (t) => void alerts.push(t),
    allowed: () => true,
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
  assert.equal(sent.length, 0, "an unpaired chat is ignored");
  assert.equal(calls.filter((c) => c.method === "sendMessage").length, 0, "and gets no answer");

  // No pairing code exists until the user opens pairing on the computer.
  assert.equal(bridge.status().pairing, undefined);
  const { code } = bridge.startPairing();
  for (let i = 0; i < 5; i++) await bridge.handle(msg("/start AAAAAAAA", 99));
  assert.equal(bridge.status().pairing, undefined, "five wrong codes close pairing");
  assert.deepEqual(alerts, ["Telegram: pairing closed"]);
  await bridge.handle(msg(`/start ${code}`));
  assert.deepEqual(config.chats, [], "the old code no longer works");

  const again = bridge.startPairing();
  await bridge.handle({ update_id: 1, message: { chat: { id: 42, type: "group" }, text: `/start ${again.code}` } });
  await bridge.handle({ update_id: 1, message: { chat: { id: 42, type: "private" }, from: { is_bot: true }, text: `/start ${again.code}` } });
  assert.deepEqual(config.chats, [], "groups and bots cannot pair");
  await bridge.handle(msg(`/start ${again.code.toLowerCase()}`));
  assert.deepEqual(config.chats, [42]);
  assert.equal(alerts.at(-1), "Telegram chat paired");
  assert.equal(bridge.status().pairing, undefined, "a code pairs one chat");
  await bridge.handle({ update_id: 1, message: { chat: { id: 42, type: "private" }, text: "forwarded", forward_origin: {} } });
  await bridge.handle(msg("what is 2+2?"));
  assert.deepEqual(sent, [["conv-1", "what is 2+2?"]]);
  assert.equal(config.conversations["42"], "conv-1");

  bridge.onConversationEvent("conv-1", { type: "assistant", turn: 1, text: "4" } as never);
  bridge.onConversationEvent("conv-1", { type: "status", status: "idle" } as never);
  bridge.onConversationEvent("conv-1", { type: "approval_request", requestId: "r1", callId: "c", name: "write_file", input: {}, preview: "notes.md", reason: "Writes a file" } as never);
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

  // Commands cannot be approved from Telegram unless the user allowed it on the computer.
  bridge.onConversationEvent("conv-1", { type: "approval_request", requestId: "r2", callId: "c", name: "run_command", input: {}, preview: "rm -rf x", reason: "Runs a command" } as never);
  await new Promise((r) => setTimeout(r, 10));
  const cmd = calls.filter((c) => c.method === "sendMessage").at(-1)!;
  assert.match(String(cmd.body.text), /on the computer or in the KesherAI app/);
  assert.equal(cmd.body.reply_markup, undefined);

  // /lock turns the bot off.
  await bridge.handle(msg("/lock"));
  assert.equal(config.enabled, false);
});

test("splitText keeps messages under Telegram's limit", () => {
  const parts = splitText(`${"a ".repeat(3000)}\n\n${"b ".repeat(3000)}`, 4000);
  assert.ok(parts.length >= 2 && parts.every((p) => p.length <= 4000));
});

test("pictures and voice messages from Telegram reach the chat", async () => {
  const http = (async (url: string, init?: { body?: string }) => {
    if (url.includes("/file/bot")) return new Response(new Uint8Array([1, 2, 3]));
    const method = url.split("/").pop()!;
    const result = method === "getMe" ? { username: "b" } : method === "getFile" ? { file_path: "photos/file_1.jpg", file_size: 3 } : method === "getUpdates" ? [] : true;
    void init;
    return new Response(JSON.stringify({ ok: true, result }));
  }) as unknown as typeof fetch;
  const config: TelegramConfig = { enabled: false, chats: [42], conversations: { "42": "c1" } };
  const sent: string[] = [];
  const saved: string[] = [];
  const bridge = new TelegramBridge(config, async () => undefined, {
    newConversation: async () => "c1",
    send: async (_c, t) => void sent.push(t),
    decide: async () => true,
    answer: async () => true,
    image: async () => undefined,
    alert: () => undefined,
    allowed: () => true,
    saveFile: async (_c, name, data) => (saved.push(`${name}:${data.length}`), `shared/${name}`),
    transcribe: async () => "  turn on the lights  ",
  }, http);
  config.token = "123456789:AAbbccddeeffgghhiijjkkllmmnnooppqq";
  await bridge.handle({ update_id: 1, message: { chat: { id: 42, type: "private" }, caption: "what breed?", photo: [{ file_id: "small" }, { file_id: "big", file_size: 3 }] } });
  assert.match(sent[0]!, /^what breed\?\n\n\(The user sent a picture from Telegram: shared\/telegram-\d+\.jpg/);
  assert.equal(saved.length, 1);
  await bridge.handle({ update_id: 2, message: { chat: { id: 42, type: "private" }, voice: { file_id: "v", file_size: 3 } } });
  assert.equal(sent[1], "turn on the lights");
  await bridge.handle({ update_id: 3, message: { chat: { id: 42, type: "private" }, photo: [{ file_id: "huge", file_size: 30 * 1024 * 1024 }] } });
  assert.equal(sent.length, 2, "a file over 20 MB is refused");
});

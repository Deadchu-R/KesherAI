import { test } from "node:test";
import assert from "node:assert/strict";
import { detectSource, htmlToText, readExport } from "./chat-import.js";

test("reads a ChatGPT export, keeping the branch the user last saw", () => {
  const data = [
    {
      title: "Trip ideas",
      create_time: 1_700_000_000,
      conversation_id: "c1",
      current_node: "a2",
      mapping: {
        root: { id: "root", message: null, parent: null, children: ["sys"] },
        sys: { id: "sys", message: { author: { role: "system" }, content: { content_type: "text", parts: [""] } }, parent: "root", children: ["u1"] },
        u1: { id: "u1", message: { author: { role: "user" }, content: { content_type: "text", parts: ["Where to go in May?"] }, create_time: 1_700_000_001 }, parent: "sys", children: ["a1", "a2"] },
        a1: { id: "a1", message: { author: { role: "assistant" }, content: { content_type: "text", parts: ["An old answer"] } }, parent: "u1", children: [] },
        a2: { id: "a2", message: { author: { role: "assistant" }, content: { content_type: "text", parts: ["Try Crete."] } }, parent: "u1", children: [] },
      },
    },
  ];
  assert.equal(detectSource(data), "chatgpt");
  const { chats } = readExport(data);
  assert.equal(chats.length, 1);
  assert.equal(chats[0]!.title, "Trip ideas");
  assert.deepEqual(chats[0]!.messages.map((m) => [m.role, m.text]), [["user", "Where to go in May?"], ["assistant", "Try Crete."]]);
  assert.equal(chats[0]!.createdAt, new Date(1_700_000_000_000).toISOString());
});

test("reads a Claude export", () => {
  const data = [
    {
      uuid: "u-1",
      name: "Regex help",
      created_at: "2025-01-02T10:00:00Z",
      chat_messages: [
        { sender: "human", text: "match dates", content: [{ type: "text", text: "match dates" }], created_at: "2025-01-02T10:00:00Z" },
        { sender: "assistant", text: "", content: [{ type: "text", text: "Use \\d{4}-\\d{2}-\\d{2}" }] },
      ],
    },
  ];
  const { source, chats } = readExport(data);
  assert.equal(source, "claude");
  assert.equal(chats[0]!.messages[1]!.text, "Use \\d{4}-\\d{2}-\\d{2}");
});

test("joins Gemini activity into chats by time", () => {
  const data = [
    { header: "Gemini Apps", title: "Prompted second", time: "2025-03-01T10:10:00Z", safeHtmlItem: [{ html: "<p>B &amp; C</p>" }] },
    { header: "Gemini Apps", title: "Prompted first", time: "2025-03-01T10:00:00Z", safeHtmlItem: [{ html: "<p>A</p>" }] },
    { header: "Gemini Apps", title: "Prompted later", time: "2025-03-02T10:00:00Z" },
    { header: "Gemini Apps", title: "Used an extension", time: "2025-03-02T10:00:00Z" },
  ];
  const { source, chats } = readExport(data);
  assert.equal(source, "gemini");
  assert.equal(chats.length, 2);
  assert.deepEqual(chats[0]!.messages.map((m) => m.text), ["first", "A", "second", "B & C"]);
  assert.equal(chats[1]!.messages.length, 1);
});

test("refuses other files and turns HTML into text", () => {
  assert.throws(() => readExport([{ hello: 1 }]), /not a chat export/);
  assert.equal(htmlToText("<ul><li>one</li><li>two</li></ul>"), "• one\n• two");
});

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

test("Open WebUI's chats export is recognised from its content and the branch the user saw is kept", async () => {
  const { readExport } = await import("./chat-import.js");
  const data = [{ id: "c1", created_at: 1762700000, chat: { title: "Shaders", history: { currentId: "m3", messages: {
    m1: { id: "m1", parentId: null, role: "user", content: "How do I make a toon shader?", timestamp: 1762700000 },
    m2: { id: "m2", parentId: "m1", role: "assistant", content: "Old answer" },
    m3: { id: "m3", parentId: "m1", role: "assistant", content: "Use a ramp texture." },
  } } } }];
  const r = readExport(data);
  assert.equal(r.source, "openwebui");
  assert.deepEqual(r.chats[0]!.messages.map((m) => m.text), ["How do I make a toon shader?", "Use a ramp texture."]);
  assert.equal(r.chats[0]!.title, "Shaders");
});

test("Jan's chats are read from its threads folder (string or OpenAI-style content)", async () => {
  const { readJanThreads } = await import("./chat-import.js");
  const { mkdtemp, mkdir, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "kesher-jan-"));
  await mkdir(join(dir, "jan_1700000000"));
  await writeFile(join(dir, "jan_1700000000", "thread.json"), JSON.stringify({ id: "jan_1700000000", title: "Tetris help", created: 1700000000 }));
  await writeFile(join(dir, "jan_1700000000", "messages.jsonl"), [
    JSON.stringify({ role: "user", content: [{ type: "text", text: { value: "Why does my piece fall through?", annotations: [] } }], created_at: 1700000001 }),
    "not json",
    JSON.stringify({ role: "assistant", content: "Check the collider." }),
  ].join("\n"));
  const chats = await readJanThreads(dir);
  assert.equal(chats.length, 1);
  assert.equal(chats[0]!.source, "jan");
  assert.deepEqual(chats[0]!.messages.map((m) => m.text), ["Why does my piece fall through?", "Check the collider."]);
  assert.deepEqual(await readJanThreads(join(dir, "missing")), []);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { detectSource, geminiHtmlToActivity, htmlToText, readExport } from "./chat-import.js";

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
  // The other answer (a1) becomes a branch of the chat, splitting at the answer.
  assert.equal(chats.length, 2);
  assert.deepEqual(chats[1]!.branchOf, { originalId: "c1", seq: 2 });
  assert.equal(chats[1]!.root, "c1");
  assert.equal(chats[1]!.messages[1]!.text, "An old answer");
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

test("reads Gemini activity from Takeout's HTML file", () => {
  const card = (first: string, when: string, answer: string, header = "Gemini Apps") =>
    `<div class="outer-cell mdl-cell mdl-cell--12-col mdl-shadow--2dp"><div class="mdl-grid"><div class="header-cell mdl-cell mdl-cell--12-col"><p class="mdl-typography--title">${header}<br></p></div><div class="content-cell mdl-cell mdl-cell--6-col mdl-typography--body-1">${first}<br>${when}<br>${answer}</div><div class="content-cell mdl-cell mdl-cell--6-col mdl-typography--body-1 mdl-typography--text-right"></div><div class="content-cell mdl-cell mdl-cell--12-col mdl-typography--caption"><b>Products:</b><br>&emsp;Gemini Apps<br></div></div></div>`;
  const html = `<html><body>${card("Prompted\u00a0second question", "Nov 13, 2026, 4:25:00\u202fPM GMT+02:00", "<p>B &amp; C</p>")}${card("Prompted first question", "Nov 13, 2026, 4:20:11 PM GMT+02:00", "<p>A</p><ul><li>x</li></ul>")}${card("Watched a video", "Nov 13, 2026, 4:00:00 PM GMT+02:00", "", "YouTube")}${card("Used an extension", "Nov 12, 2026, 4:00:00 PM GMT+02:00", "")}</body></html>`;
  const items = geminiHtmlToActivity(html);
  assert.equal(items.length, 2);
  const { source, chats } = readExport(items);
  assert.equal(source, "gemini");
  assert.equal(chats.length, 1);
  assert.equal(readExport(items, "gap").chats.length, 1);
  assert.deepEqual(chats[0]!.messages.map((m) => [m.role, m.text]), [["user", "first question"], ["assistant", "A\n• x"], ["user", "second question"], ["assistant", "B & C"]]);
});

test("ChatGPT: an edited message becomes a branch; pictures, attachments, code and custom instructions are kept", () => {
  const node = (id: string, parent: string | null, children: string[], message: unknown) => ({ id, parent, children, message });
  const msg = (role: string, content: unknown, extra: Record<string, unknown> = {}) => ({ author: { role }, content, create_time: 1_700_000_100, ...extra });
  const data = [{
    title: "Logo", create_time: 1_700_000_000, conversation_id: "c2", current_node: "a2",
    mapping: {
      root: node("root", null, ["ctx"], null),
      ctx: node("ctx", "root", ["u1", "u1b"], msg("user", { content_type: "user_editable_context", user_profile: "I make games.", user_instructions: "Answer in Hebrew." }, { metadata: { is_visually_hidden_from_conversation: true } })),
      u1: node("u1", "ctx", ["code"], msg("user", { content_type: "multimodal_text", parts: [{ content_type: "image_asset_pointer", asset_pointer: "file-service://file-Ab12" }, "Draw a logo like this"] }, { metadata: { attachments: [{ id: "file-Ab12", name: "sketch.png" }] } })),
      code: node("code", "u1", ["img"], msg("assistant", { content_type: "code", language: "unknown", text: "print('hi')" })),
      img: node("img", "code", ["a2"], msg("tool", { content_type: "multimodal_text", parts: [{ content_type: "image_asset_pointer", asset_pointer: "sediment://file_00ff" }] })),
      a2: node("a2", "img", [], msg("assistant", { content_type: "text", parts: ["Here it is."] })),
      u1b: node("u1b", "ctx", ["a1b"], msg("user", { content_type: "text", parts: ["Draw a cat instead"] })),
      a1b: node("a1b", "u1b", [], msg("assistant", { content_type: "text", parts: ["A cat."] })),
    },
  }];
  const { chats, personas } = readExport(data);
  assert.equal(chats.length, 2);
  const [main, branch] = chats;
  assert.deepEqual(main!.messages.map((m) => m.role), ["user", "assistant", "assistant", "assistant"]);
  assert.deepEqual(main!.messages[0]!.files, [{ name: "sketch.png", ref: "file-service://file-Ab12" }]);
  assert.equal(main!.messages[1]!.text, "```python\nprint('hi')\n```");
  assert.deepEqual(main!.messages[2]!.files, [{ name: "file_00ff", ref: "sediment://file_00ff" }], "a DALL·E picture is the assistant's");
  assert.deepEqual(branch!.branchOf, { originalId: "c2", seq: 1 }, "the edited first message");
  assert.equal(branch!.messages[0]!.text, "Draw a cat instead");
  assert.deepEqual(personas, [{ name: "ChatGPT custom instructions", instructions: "I make games.\n\nAnswer in Hebrew." }]);
});

test("Claude: artifacts become code blocks, attachments keep their text, projects become personas", () => {
  const data = [
    { uuid: "k1", name: "Shader", created_at: "2025-01-02T10:00:00Z", chat_messages: [
      { sender: "human", text: "fix it", content: [{ type: "text", text: "fix it" }], attachments: [{ file_name: "toon.hlsl", extracted_content: "float4 main()" }], files: [{ file_name: "shot.png" }] },
      { sender: "assistant", content: [{ type: "text", text: "Fixed:" }, { type: "tool_use", name: "artifacts", input: { title: "Toon", language: "hlsl", content: "float4 main() { return 1; }" } }] },
    ] },
    { uuid: "p1", name: "Unreal helper", prompt_template: "You know Unreal 5.", docs: [] },
  ];
  const { source, chats, personas } = readExport(data);
  assert.equal(source, "claude");
  assert.deepEqual(chats[0]!.messages[0]!.files, [{ name: "toon.hlsl", text: "float4 main()" }, { name: "shot.png" }]);
  assert.equal(chats[0]!.messages[1]!.text, "Fixed:\n\n**Toon**\n\n```hlsl\nfloat4 main() { return 1; }\n```");
  assert.deepEqual(personas, [{ name: "Unreal helper", instructions: "You know Unreal 5." }]);
});

test("Open WebUI: other answers become branches and inline pictures are kept", () => {
  const data = [{ id: "w1", created_at: 1762700000, chat: { title: "Cats", params: { system: "Be brief.", temperature: 0.4 }, history: { currentId: "m3", messages: {
    m1: { id: "m1", parentId: null, childrenIds: ["m2", "m3"], role: "user", content: "What is this?", files: [{ type: "image", url: "data:image/png;base64,iVBORw0KGgo=" }] },
    m2: { id: "m2", parentId: "m1", childrenIds: [], role: "assistant", content: "A dog" },
    m3: { id: "m3", parentId: "m1", childrenIds: [], role: "assistant", content: "A cat" },
  } } } }];
  const { chats, personas } = readExport(data);
  assert.equal(chats.length, 2);
  assert.deepEqual(chats[0]!.messages[0]!.files, [{ name: "image-1.png", data: "iVBORw0KGgo=" }]);
  assert.equal(chats[0]!.messages[1]!.text, "A cat");
  assert.deepEqual(chats[1]!.branchOf, { originalId: "w1", seq: 2 });
  assert.deepEqual(personas, [{ name: "Open WebUI: Cats", instructions: "Be brief.", params: { temperature: 0.4 } }]);
});

test("LM Studio: the selected versions make the chat, the others branches; its prompt and settings a persona", () => {
  const chat = {
    name: "Rust help", createdAt: 1_762_700_000_000, systemPrompt: "You are a Rust expert.",
    perChatPredictionConfig: { fields: [{ key: "llm.prediction.temperature", value: 0.2 }, { key: "llm.prediction.topPSampling", value: { checked: true, value: 0.9 } }] },
    messages: [
      { versions: [{ type: "singleStep", role: "user", content: [{ type: "text", text: "Borrow checker?" }] }], currentlySelected: 0 },
      { versions: [
        { type: "multiStep", role: "assistant", steps: [{ type: "contentBlock", content: [{ type: "text", text: "First try" }] }] },
        { type: "multiStep", role: "assistant", steps: [{ type: "contentBlock", content: [{ type: "text", text: "It checks " }, { type: "text", text: "lifetimes." }] }] },
      ], currentlySelected: 1 },
    ],
  };
  const { source, chats, personas } = readExport(chat);
  assert.equal(source, "lmstudio");
  assert.equal(chats[0]!.title, "Rust help");
  assert.equal(chats[0]!.createdAt, new Date(1_762_700_000_000).toISOString(), "milliseconds");
  assert.deepEqual(chats[0]!.messages.map((m) => m.text), ["Borrow checker?", "It checks lifetimes."]);
  assert.deepEqual(chats[1]!.messages.map((m) => m.text), ["Borrow checker?", "First try"]);
  assert.equal(chats[1]!.branchOf?.seq, 2);
  assert.deepEqual(personas, [{ name: "LM Studio: Rust help", instructions: "You are a Rust expert.", params: { temperature: 0.2, topP: 0.9 } }]);
});

test("Gemini: entries that link their chat are grouped by it, in either JSON shape, with attached files", () => {
  const data = [
    { header: "Gemini Apps", title: "Prompted one", titleUrl: "https://gemini.google.com/app/abc123def", time: "2025-03-01T10:00:00Z", attachedFiles: ["plan.pdf"] },
    { header: "Gemini", title: "Used Gemini Apps", titleUrl: "https://gemini.google.com/app/c/zzz999yyy", time: "2025-03-02T09:00:00Z", details: [{ name: "Request", value: "other chat" }, { name: "Response", value: "<p>ok</p>" }] },
    { header: "Gemini Apps", title: "Prompted two", titleUrl: "https://gemini.google.com/app/abc123def", time: "2025-03-03T10:00:00Z" },
  ];
  const { chats } = readExport(data);
  assert.equal(chats.length, 2, "two chats by id, though days apart");
  assert.equal(chats[0]!.originalId, "c:abc123def");
  assert.deepEqual(chats[0]!.messages.map((m) => m.text), ["one", "two"]);
  assert.deepEqual(chats[0]!.messages[0]!.files, [{ name: "plan.pdf", ref: "gemini:plan.pdf" }]);
  assert.deepEqual(chats[1]!.messages.map((m) => m.text), ["other chat", "ok"]);
});

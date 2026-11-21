import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import { ExportReader, type ImportedChat } from "./chat-import.js";
import { isChatEntry, JsonItemSplitter, scanImportFile } from "./import-stream.js";

test("the splitter cuts a list into its elements across pieces, minding strings and escapes", () => {
  const items: unknown[] = [];
  const s = new JsonItemSplitter((x) => items.push(x));
  const text = JSON.stringify([{ a: "}{ ]\"[" }, { b: [1, { c: "\\" }] }, { d: "שלום" }]);
  for (let i = 0; i < text.length; i += 3) s.push(text.slice(i, i + 3));
  s.end();
  assert.deepEqual(items, [{ a: "}{ ]\"[" }, { b: [1, { c: "\\" }] }, { d: "שלום" }]);
  assert.equal(s.broken, 0);

  const one: unknown[] = [];
  const o = new JsonItemSplitter((x) => one.push(x));
  o.push('﻿  {"name": "x", "messages": []}');
  assert.deepEqual(one, [{ name: "x", messages: [] }], "a single object");

  const cut = new JsonItemSplitter(() => undefined);
  cut.push('[{"a": 1}, {"b": ');
  cut.end();
  assert.equal(cut.broken, 1, "a cut-off file");
  const html = new JsonItemSplitter(() => undefined);
  html.push("hello");
  assert.equal(html.notJson, true);
});

test("which zip entries hold chats", () => {
  assert.equal(isChatEntry("conversations.json"), true);
  assert.equal(isChatEntry("conversations-003.json"), true);
  assert.equal(isChatEntry("data-2025/projects.json"), true);
  assert.equal(isChatEntry("Takeout/My Activity/Gemini Apps/MyActivity.html"), true);
  assert.equal(isChatEntry("Rust help.conversation.json"), true);
  assert.equal(isChatEntry("user.json"), false);
  assert.equal(isChatEntry("file-Ab12-photo.png"), false);
});

test("a zip is read entry by entry: split ChatGPT files, pictures only listed unless asked for", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kesher-istream-"));
  try {
    const conv = (id: string) => ({ conversation_id: id, title: id, create_time: 1_700_000_000, current_node: "u", mapping: { u: { parent: null, children: [], message: { author: { role: "user" }, content: { content_type: "text", parts: [`hi ${id}`] } } } } });
    const zip = zipSync({
      "conversations-000.json": strToU8(JSON.stringify([conv("a")])),
      "conversations-001.json": strToU8(JSON.stringify([conv("b")])),
      "user.json": strToU8('{"email":"x"}'),
      "file-Ab12-photo.png": new Uint8Array([1, 2, 3]),
    });
    const path = join(dir, "export.zip");
    await writeFile(path, zip);
    const chats: ImportedChat[] = [];
    const reader = new ExportReader((c) => chats.push(c));
    const r = await scanImportFile(path, reader);
    assert.equal(r.zip, true);
    assert.deepEqual(chats.map((c) => c.originalId), ["a", "b"]);
    assert.deepEqual(r.entries.sort(), ["file-Ab12-photo.png", "user.json"]);
    // Media only: the picture's bytes, no chats.
    const got: number[] = [];
    const again: ImportedChat[] = [];
    await scanImportFile(path, new ExportReader((c) => again.push(c)), { mediaOnly: true, media: (n) => (n.endsWith(".png") ? (d) => got.push(...d) : undefined) });
    assert.deepEqual(got, [1, 2, 3]);
    assert.equal(again.length, 0);
    // A plain JSON file, and something that is no export.
    await writeFile(join(dir, "c.json"), JSON.stringify([conv("c")]));
    const plain: ImportedChat[] = [];
    await scanImportFile(join(dir, "c.json"), new ExportReader((c) => plain.push(c)));
    assert.equal(plain[0]?.originalId, "c");
    await writeFile(join(dir, "x.txt"), "just words");
    assert.equal((await scanImportFile(join(dir, "x.txt"), new ExportReader(() => undefined))).unknown, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

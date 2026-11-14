import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readAttachments } from "./attachments.js";

test("attachments: a picture goes as a picture, a text file as its text; files outside the chat's folders are not read", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "att-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const chat = join(dir, "chat");
  mkdirSync(join(chat, "shared"), { recursive: true });
  writeFileSync(join(chat, "shared", "cat.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  writeFileSync(join(chat, "notes.md"), "# Plan\nBuy milk.");
  writeFileSync(join(dir, "secret.txt"), "do not read");
  const r = await readAttachments(`what is this?\n[Attached: ${join(chat, "shared", "cat.png")}]\n[מצורף: notes.md]\n[Attached: ${join(dir, "secret.txt")}]`, [chat]);
  assert.equal(r.images.length, 1);
  assert.equal(r.images[0]!.mimeType, "image/png");
  assert.match(r.context!, /cat\.png: the picture is attached/);
  assert.match(r.context!, /The attached file notes\.md[\s\S]*Buy milk/);
  assert.doesNotMatch(r.context!, /do not read/);
});

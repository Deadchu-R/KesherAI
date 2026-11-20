import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
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

test("an attached code file is read as code, and a recording through the media reader", async () => {
  const dir = mkdtempSync(join(tmpdir(), "att-"));
  writeFileSync(join(dir, "Move.cs"), "float speed = 3f;");
  writeFileSync(join(dir, "talk.mp3"), "not really audio");
  const r = await readAttachments("look [Attached: Move.cs] and [Attached: talk.mp3]", [dir], async () => ({ transcript: "שלום עולם", frames: [] }));
  assert.match(r.context ?? "", /```cs\nfloat speed = 3f;\n```/);
  assert.match(r.context ?? "", /recording talk\.mp3: what is said in it:\nשלום עולם/);
  const v = await readAttachments("[Attached: talk.mp3]", [dir]);
  assert.match(v.context ?? "", /talk\.mp3: a recording or video.*transcribe_audio/, "no media reader: the model is pointed to its tool");
});

test("an attached folder and ZIP come as an outline with their README; other files get an honest note", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "att-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "game", "src"), { recursive: true });
  mkdirSync(join(dir, "game", "node_modules", "x"), { recursive: true });
  writeFileSync(join(dir, "game", "README.md"), "# Space game\nA shooter.");
  writeFileSync(join(dir, "game", "src", "main.ts"), "export {};");
  writeFileSync(join(dir, "game", "node_modules", "x", "index.js"), "skip me");
  writeFileSync(join(dir, "pack.zip"), zipSync({ "docs/README.md": strToU8("# Inside the zip"), "a/b.txt": strToU8("b") }));
  writeFileSync(join(dir, "model.blend"), Buffer.from([0, 1, 2]));
  writeFileSync(join(dir, "big.7z"), Buffer.from([0, 1]));
  const r = await readAttachments("[Attached: game]\n[Attached: pack.zip]\n[Attached: model.blend]\n[Attached: big.7z]", [dir]);
  const c = r.context ?? "";
  assert.match(c, /The attached folder game .*2 files/);
  assert.match(c, /src\/\n {2}main\.ts/);
  assert.doesNotMatch(c, /node_modules|skip me/);
  assert.match(c, /Its README\.md:\n# Space game/);
  assert.match(c, /The attached archive pack\.zip .*2 files[\s\S]*a\/b\.txt[\s\S]*Its docs\/README\.md:\n# Inside the zip/);
  assert.match(c, /model\.blend: a blend file, 3 B.*no reader for this kind/);
  assert.match(c, /big\.7z: a 7z archive.*not listed/);
});

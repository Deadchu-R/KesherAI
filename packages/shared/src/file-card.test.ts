import { test } from "node:test";
import assert from "node:assert/strict";
import { FILE_CARD_PREVIEW_LIMIT, fileCardIcon, fileCardKind, fileCardPreview, fileCardSize, firstLines } from "./file-card.js";

test("file card kind and preview follow the file's type", () => {
  const cases: Array<[string, string, string]> = [
    ["shot.PNG", "image", "image"], ["report.pdf", "pdf", "pdf-page"], ["notes.md", "markdown", "markdown"], ["page.html", "html", "html"],
    ["main.ts", "code", "lines"], ["a.txt", "text", "lines"], ["data.csv", "table", "table"], ["pack.zip", "archive", "none"],
    ["song.mp3", "audio", "player"], ["x.weird", "other", "none"], ["noext", "other", "none"],
  ];
  for (const [name, kind, preview] of cases) {
    assert.equal(fileCardKind(name), kind, name);
    assert.equal(fileCardPreview(fileCardKind(name), 1000, "render"), preview, name);
    assert.ok(fileCardIcon(fileCardKind(name)));
  }
});

test("no preview for attach, empty or over 200 MB files", () => {
  assert.equal(fileCardPreview("image", 1000, "attach"), "none");
  assert.equal(fileCardPreview("image", 0, "render"), "none");
  assert.equal(fileCardPreview("pdf", FILE_CARD_PREVIEW_LIMIT + 1, "render"), "none");
  assert.equal(fileCardPreview("pdf", FILE_CARD_PREVIEW_LIMIT, "render"), "pdf-page");
});

test("sizes and first lines", () => {
  assert.equal(fileCardSize(512), "512 B");
  assert.equal(fileCardSize(1536), "1.5 KB");
  assert.equal(fileCardSize(3 * 1024 ** 2), "3.0 MB");
  const r = firstLines(Array.from({ length: 50 }, (_, i) => `l${i}`).join("\n"));
  assert.equal(r.text.split("\n").length, 40);
  assert.equal(r.more, 10);
  assert.deepEqual(firstLines("a\r\nb", 5), { text: "a\nb", more: 0 });
});

test("first page of a PDF's text", async () => {
  const { firstPdfPage } = await import("./file-card.js");
  assert.equal(firstPdfPage("— 1 —\nHello\nworld\n\n— 2 —\nSecond"), "Hello\nworld");
  assert.equal(firstPdfPage("— 1 —\nOnly"), "Only");
});

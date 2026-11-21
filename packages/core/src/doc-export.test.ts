import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strFromU8, unzipSync } from "fflate";
import { AssetStore } from "./assets.js";
import { DocStore, docTools } from "./docs.js";
import { docToDocx, exportDoc, parseDocFormat } from "./doc-export.js";

test("parseDocFormat reads the names people use", () => {
  assert.equal(parseDocFormat("PDF"), "pdf");
  assert.equal(parseDocFormat("word"), "docx");
  assert.equal(parseDocFormat(".md"), "md");
  assert.equal(parseDocFormat("odt"), undefined);
});

test("a Word file holds the text, with right to left for Hebrew and escaped markup", () => {
  const files = unzipSync(docToDocx("כותרת", "## חלק\n- נקודה **חשובה**\n\nA < B & C"));
  assert.deepEqual(Object.keys(files).sort(), ["[Content_Types].xml", "_rels/.rels", "word/document.xml"]);
  const xml = strFromU8(files["word/document.xml"]!);
  assert.match(xml, /<w:bidi\/>/);
  assert.match(xml, /נקודה/);
  assert.match(xml, /A &lt; B &amp; C/);
});

test("exportDoc: markdown and Word work here; a PDF needs the desktop renderer and an empty document is refused", async () => {
  const doc = { title: "מדריך / ראשון", body: "# שלום\nטקסט" };
  const md = await exportDoc(doc, "md");
  assert.equal(md.fileName, "מדריך ראשון.md");
  assert.match(strFromU8(md.data), /^# מדריך/);
  assert.equal((await exportDoc(doc, "docx")).mimeType.includes("wordprocessingml"), true);
  await assert.rejects(exportDoc(doc, "pdf"), /cannot be made here/);
  let html = "";
  const pdf = await exportDoc(doc, "pdf", async (h) => ((html = h), new Uint8Array([37, 80, 68, 70])));
  assert.equal(pdf.mimeType, "application/pdf");
  assert.match(html, /<h2[^>]*>שלום<\/h2>/);
  await assert.rejects(exportDoc({ title: "x", body: " " }, "md"), /empty/);
});

test("the document tool's export saves a real asset and returns its link; without a renderer it does not claim a PDF", async () => {
  const dir = await mkdtemp(join(tmpdir(), "docx-"));
  try {
    const store = new DocStore(join(dir, "docs"));
    await mkdir(join(dir, "assets"));
    const assets = new AssetStore(join(dir, "assets"));
    const [tool] = docTools(store, "c1", () => "chat", { assets, renderPdf: async () => new Uint8Array([37, 80, 68, 70, 45]) });
    const run = (input: Record<string, unknown>) => tool!.run(input, {} as never) as Promise<{ output: string }>;
    assert.match((await run({ action: "write", title: "מדריך", body: "## א\nטקסט" })).output, /not a PDF or Word file/);
    const out = (await run({ action: "export", format: "pdf" })).output;
    const id = /\/api\/assets\/([0-9a-f-]{36})/.exec(out)?.[1];
    assert.ok(id, out);
    assert.equal((await assets.get(id))?.asset.mimeType, "application/pdf");
    const [noPdf] = docTools(store, "c1", () => "chat", { assets });
    await assert.rejects(noPdf!.run({ action: "export", format: "pdf" }, {} as never), /cannot be made here/);
    assert.match(((await noPdf!.run({ action: "export", format: "docx" }, {} as never)) as { output: string }).output, /Word/);
    assert.equal((docTools(store, "c1", () => "chat")[0]!.spec.inputSchema as { properties: { action: { enum: string[] } } }).properties.action.enum.includes("export"), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

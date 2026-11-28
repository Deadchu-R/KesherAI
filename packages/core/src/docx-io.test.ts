import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync, crc32 } from "node:zlib";
import { strFromU8, unzipSync } from "fflate";
import { DocStore } from "./docs.js";
import { guardDocxPath, imageInfo, isRtlText } from "./docx-io.js";
import { docxTools, exportDocx, importDocx, saveDocx, type DocxDeps } from "./docx-service.js";

/** A real 3x2 red PNG, made here. */
function png(): Uint8Array {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(3, 0);
  ihdr.writeUInt32BE(2, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from([255, 0, 0, 255, 0, 0, 255, 0, 0])]);
  return new Uint8Array(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.concat([row, row]))), chunk("IEND", Buffer.alloc(0))]));
}

/** A fixture Word file built with the docx library: a Hebrew RTL paragraph, a heading, a table, a bullet list, a link, an image. */
async function fixture(): Promise<Uint8Array> {
  const D = await import("docx");
  const cell = (t: string) => new D.TableCell({ children: [new D.Paragraph({ children: [new D.TextRun(t)] })] });
  const doc = new D.Document({
    sections: [
      {
        children: [
          new D.Paragraph({ heading: D.HeadingLevel.HEADING_1, children: [new D.TextRun("Plan")] }),
          new D.Paragraph({ bidirectional: true, children: [new D.TextRun({ text: "שלום עולם, זו פסקה בעברית", rightToLeft: true }), new D.TextRun({ text: " מודגש", bold: true, rightToLeft: true })] }),
          new D.Paragraph({ children: [new D.TextRun("See "), new D.ExternalHyperlink({ link: "https://example.com/a", children: [new D.TextRun({ text: "the site", style: "Hyperlink" })] }), new D.TextRun(" and "), new D.TextRun({ text: "italic", italics: true })] }),
          new D.Paragraph({ bullet: { level: 0 }, children: [new D.TextRun("first")] }),
          new D.Paragraph({ bullet: { level: 1 }, children: [new D.TextRun("nested")] }),
          new D.Paragraph({ bullet: { level: 0 }, children: [new D.TextRun("second")] }),
          new D.Table({ rows: [new D.TableRow({ children: [cell("Name"), cell("Qty")] }), new D.TableRow({ children: [cell("Apple"), cell("3")] })] }),
          new D.Paragraph({ children: [new D.ImageRun({ type: "png", data: png(), transformation: { width: 30, height: 20 }, altText: { name: "pic", description: "pic", title: "pic" } })] }),
        ],
      },
    ],
  });
  return new Uint8Array(await D.Packer.toBuffer(doc));
}

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "docx-"));
  const files = new Map<string, { data: Buffer; mimeType: string }>();
  let n = 0;
  const assets = {
    async save(data: Uint8Array, mimeType: string) {
      const id = `00000000-0000-0000-0000-${String(++n).padStart(12, "0")}`;
      files.set(id, { data: Buffer.from(data), mimeType });
      return { id, kind: "image", mimeType, createdAt: "" } as never;
    },
    async get(id: string) {
      const f = files.get(id);
      return f ? ({ asset: { id, mimeType: f.mimeType } as never, data: f.data }) : undefined;
    },
  };
  const home = join(dir, "Documents");
  await mkdir(home);
  const deps: DocxDeps = { docs: new DocStore(join(dir, "docs")), assets, roots: async () => [home] };
  return { dir, home, deps, files };
}

test("isRtlText: by the majority of letters; imageInfo reads a PNG header", () => {
  assert.equal(isRtlText("שלום עולם hi"), true);
  assert.equal(isRtlText("hello שלום there friend"), false);
  assert.equal(isRtlText("123 !!"), false);
  assert.deepEqual(imageInfo(png()), { type: "png", width: 3, height: 2 });
});

test("round trip: import, export, import again keeps heading, RTL, link, list, table and image", async () => {
  const t = await setup();
  try {
    const file = join(t.home, "plan.docx");
    await writeFile(file, await fixture());
    const a = await importDocx(t.deps, { path: file });
    assert.equal(a.title, "plan");
    assert.equal(a.source?.path.endsWith("plan.docx"), true);
    assert.match(a.body, /^# Plan$/m);
    assert.match(a.body, /שלום עולם, זו פסקה בעברית \*\*מודגש\*\*/);
    assert.match(a.body, /\[the site\]\(https:\/\/example\.com\/a\)/);
    assert.match(a.body, /\*italic\*/);
    assert.match(a.body, /^- first\n {2}- nested\n- second$/m);
    assert.match(a.body, /\| Name \| Qty \|\n\| --- \| --- \|\n\| Apple \| 3 \|/);
    assert.match(a.body, /!\[[^\]]*\]\(\/api\/assets\/[0-9a-f-]{36}\)/);

    const out = await exportDocx(t.deps, a);
    const xml = strFromU8(unzipSync(out)["word/document.xml"]!);
    assert.match(xml, /<w:bidi\/>|<w:bidi w:val="(1|true)"\/>/, "the Hebrew paragraph is a right-to-left one");
    assert.match(xml, /<w:rtl\/>|<w:rtl w:val="(1|true)"\/>/);
    assert.match(xml, /<w:hyperlink/);
    assert.match(xml, /<w:tbl>/);
    assert.match(xml, /<w:drawing>/);

    const f2 = join(t.home, "again.docx");
    await writeFile(f2, out);
    const b = await importDocx(t.deps, { path: f2 });
    // The same text; the picture is a new asset, so compare with its address masked.
    const mask = (s: string) => s.replace(/\/api\/assets\/[0-9a-f-]{36}/g, "/api/assets/X");
    assert.equal(mask(b.body), mask(a.body));
    assert.equal(t.files.size, 2);
  } finally {
    await rm(t.dir, { recursive: true, force: true });
  }
});

test("an upload comes in without a source path; a Markdown document exports as a Word file with RTL tables", async () => {
  const t = await setup();
  try {
    const d = await importDocx(t.deps, { name: "מסמך.docx", data: await fixture() });
    assert.equal(d.title, "מסמך");
    assert.equal(d.source, undefined);
    const md = "# כותרת\n\nטקסט בעברית עם **מודגש**.\n\n1. אחד\n2. שניים\n\n| שם | כמות |\n| --- | --- |\n| תפוח | 3 |\n\n> ציטוט\n\n```\ncode\n```";
    const xml = strFromU8(unzipSync(await exportDocx(t.deps, { title: "x", body: md }))["word/document.xml"]!);
    assert.match(xml, /<w:bidi/);
    assert.match(xml, /w:visuallyRightToLeft|<w:bidiVisual/);
    assert.match(xml, /<w:numPr>/);
  } finally {
    await rm(t.dir, { recursive: true, force: true });
  }
});

test("path guard: only absolute .docx paths inside the allowed folders; links out are refused", async () => {
  const t = await setup();
  try {
    await writeFile(join(t.dir, "secret.docx"), "x");
    await symlink(join(t.dir, "secret.docx"), join(t.home, "link.docx"));
    await assert.rejects(guardDocxPath("relative.docx", [t.home]), /full path/);
    await assert.rejects(guardDocxPath(join(t.home, "a.txt"), [t.home]), /full path/);
    await assert.rejects(guardDocxPath(join(t.dir, "secret.docx"), [t.home]), /not in a folder/);
    await assert.rejects(guardDocxPath(join(t.home, "..", "secret.docx"), [t.home]), /not in a folder/);
    await assert.rejects(guardDocxPath(join(t.home, "link.docx"), [t.home]), /not in a folder/);
    assert.equal(await guardDocxPath(join(t.home, "new.docx"), [t.home]), join(await (await import("node:fs/promises")).realpath(t.home), "new.docx"));
    await assert.rejects(importDocx(t.deps, { path: join(t.dir, "secret.docx") }), /not in a folder/);
  } finally {
    await rm(t.dir, { recursive: true, force: true });
  }
});

test("save back: keeps one .bak of the original, overwrites the file, and docx_save needs a path for a document with no file", async () => {
  const t = await setup();
  try {
    const file = join(t.home, "plan.docx");
    const original = await fixture();
    await writeFile(file, original);
    const d = await importDocx(t.deps, { path: file });
    await t.deps.docs.update(d.id, (x) => void (x.body += "\n\nNew paragraph added."), true);
    const r1 = await saveDocx(t.deps, d.id);
    assert.equal(r1.bak, true);
    assert.deepEqual(new Uint8Array(await readFile(`${file}.bak`)), original);
    const saved = await readFile(file);
    assert.notDeepEqual(new Uint8Array(saved), original);
    const again = await importDocx(t.deps, { path: file });
    assert.match(again.body, /New paragraph added\./);
    // A second save does not touch the .bak.
    const r2 = await saveDocx(t.deps, d.id);
    assert.equal(r2.bak, false);
    assert.deepEqual(new Uint8Array(await readFile(`${file}.bak`)), original);

    const [open, save] = docxTools(t.deps);
    const plain = await t.deps.docs.create({ title: "n", body: "hello" });
    await assert.rejects(save!.run({ doc_id: plain.id }, {} as never), /give the path/);
    const out = (await save!.run({ doc_id: plain.id, path: join(t.home, "n.docx") }, {} as never)) as { output: string };
    assert.match(out.output, /n\.docx/);
    assert.equal((await stat(join(t.home, "n.docx"))).isFile(), true);
    const o = (await open!.run({ path: join(t.home, "n.docx") }, {} as never)) as { output: string };
    assert.match(o.output, /#\/docs\//);
    await assert.rejects(open!.run({ path: "/etc/passwd.docx" }, {} as never), /not in a folder|No such/);
  } finally {
    await rm(t.dir, { recursive: true, force: true });
  }
});

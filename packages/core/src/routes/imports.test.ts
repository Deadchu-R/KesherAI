import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { zipSync, strToU8 } from "fflate";
import { pptxFiles } from "@kesher/shared";
import { DocStore } from "../docs.js";
import { DeckStore } from "../decks.js";
import { SheetStore } from "../sheets.js";
import { importRoutes } from "./imports.js";

test("import: PowerPoint into slides, CSV into a sheet, Markdown into a document; others refused", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kesher-import-"));
  const app = Fastify();
  try {
    const stores = { docs: new DocStore(join(dir, "d")), decks: new DeckStore(join(dir, "k")), sheets: new SheetStore(join(dir, "s")) };
    await importRoutes(app, stores);
    const files = pptxFiles("מצגת", [{ title: "פתיחה", bullets: [] }, { title: "חוסמי בטא", bullets: ["β1 בלב", "הדופק יורד"] }]);
    const pptx = Buffer.from(zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, typeof v === "string" ? strToU8(v) : v]))));
    const post = (name: string, data: Buffer) => app.inject({ method: "POST", url: "/api/import", payload: { name, data: data.toString("base64") } });
    const r1 = (await post("lecture.pptx", pptx)).json() as { kind: string; id: string };
    assert.equal(r1.kind, "slides");
    const deck = await stores.decks.get(r1.id);
    assert.equal(deck!.slides[2]!.title, "חוסמי בטא");
    assert.deepEqual(deck!.slides[2]!.bullets, ["β1 בלב", "הדופק יורד"]);
    const r2 = (await post("ציונים.csv", Buffer.from("﻿קורס,ציון\nפיזיו,88"))).json() as { kind: string; id: string };
    assert.equal((await stores.sheets.get(r2.id))!.cells.B2, "88");
    assert.equal((await stores.sheets.get(r2.id))!.title, "ציונים");
    const r3 = (await post("notes.md", Buffer.from("# שלום\n\nטקסט"))).json() as { kind: string; id: string };
    assert.equal((await stores.docs.get(r3.id))!.body, "# שלום\n\nטקסט");
    assert.equal((await post("x.exe", Buffer.from("MZ"))).statusCode, 400);
    assert.equal((await post("x.md", Buffer.from(""))).statusCode, 400);
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

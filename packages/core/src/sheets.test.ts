import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SheetStore, sheetTools } from "./sheets.js";

test("sheets: saves changes from the revision, grows the grid, keeps versions; the tool reads and sets", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kesher-sheets-"));
  try {
    const store = new SheetStore(dir);
    const s = await store.create({ title: "ציונים", cells: { A1: "קורס", B1: "ציון" } });
    const a = await store.save(s.id, { changes: { A2: "פיזיולוגיה", B2: "88", C40: "x", "../x": "y" }, rev: s.rev });
    assert.equal(a.rows, 40);
    assert.equal(a.cells["../x"], undefined);
    await assert.rejects(() => store.save(s.id, { changes: { A3: "z" }, rev: s.rev }), /changed/);
    const b = await store.save(s.id, { changes: { C40: "" }, rev: a.rev });
    assert.equal(b.cells.C40, undefined);
    const [tool] = sheetTools(store, "c1", () => "chat");
    await tool!.run({ action: "set", id: s.id, cells: { B3: "=AVERAGE(B2:B2)" } }, {} as never);
    assert.match((await tool!.run({ action: "read", id: s.id }, {} as never)).output as string, /B3: =AVERAGE\(B2:B2\) → 88/);
    await assert.rejects(() => Promise.resolve(tool!.run({ action: "read", id: "nope" }, {} as never)));
    const own = await tool!.run({ action: "write", cells: { A1: "1" } }, {} as never);
    assert.match(own.output as string, /#\/sheets\/chat-c1/);
    assert.equal((await store.restore(s.id, 0)).cells.A2, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DocStore, docTools, findSection } from "./docs.js";

test("findSection: from a heading to the next of the same or higher level", () => {
  const b = "# A\nx\n## B\ny\n### C\nz\n## D\nw";
  const s = findSection(b, "B")!;
  assert.equal(b.slice(s.start, s.end), "## B\ny\n### C\nz\n");
  assert.equal(findSection(b, "nope"), undefined);
});

test("a chat's document: write, append, replace a section; the page saves with its revision", async () => {
  const dir = await mkdtemp(join(tmpdir(), "docs-"));
  try {
    const store = new DocStore(dir);
    const [tool] = docTools(store, "c1", () => "סיכום");
    const run = (input: Record<string, unknown>) => tool!.run(input, {} as never) as Promise<{ output: string }>;
    await run({ action: "write", title: "חוסמי בטא", body: "## מנגנון\nחוסמים β1.\n\n## תופעות\nעייפות." });
    await run({ action: "section", heading: "מנגנון", body: "## מנגנון\nחוסמים קולטני β1 בלב." });
    await run({ action: "append", body: "## מינונים\nלפי ההרצאה." });
    const d = (await store.get("chat-c1"))!;
    assert.equal(d.body, "## מנגנון\nחוסמים קולטני β1 בלב.\n\n## תופעות\nעייפות.\n\n## מינונים\nלפי ההרצאה.");
    await assert.rejects(store.save(d.id, { body: "x", rev: d.rev - 1 }), /changed/);
    assert.equal((await store.save(d.id, { body: "חדש", rev: d.rev })).body, "חדש");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("importPages: the older pages become documents once, with the same id", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kesher-docs-"));
  try {
    await mkdir(join(dir, "pages"));
    await writeFile(join(dir, "pages", "p1.json"), JSON.stringify({ id: "p1", title: "ישן", content: "# שלום", updatedAt: "2026-01-01T00:00:00.000Z" }));
    await writeFile(join(dir, "pages", "bad.json"), "{");
    const store = new DocStore(join(dir, "docs"));
    assert.equal(await store.importPages(join(dir, "pages")), 1);
    assert.equal((await store.get("p1"))?.body, "# שלום");
    assert.equal(await store.importPages(join(dir, "pages")), 0);
    assert.equal(await store.importPages(join(dir, "none")), 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("document tool: edits another document by its id, refuses an unknown one", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kesher-docs-"));
  try {
    const store = new DocStore(dir);
    const other = await store.create({ title: "שלי", body: "א" });
    const [tool] = docTools(store, "c1", () => "chat");
    await tool!.run({ action: "append", id: other.id, body: "ב" }, {} as never);
    assert.equal((await store.get(other.id))?.body, "א\n\nב");
    assert.equal(await store.get("chat-c1"), undefined);
    await assert.rejects(() => Promise.resolve(tool!.run({ action: "read", id: "nope" }, {} as never)));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

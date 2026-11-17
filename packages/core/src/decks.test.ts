import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeckStore, deckTools } from "./decks.js";

test("a chat's deck: the model writes, changes and adds slides; the page saves with its revision; versions restore", async () => {
  const dir = await mkdtemp(join(tmpdir(), "decks-"));
  try {
    const store = new DeckStore(dir);
    const [tool] = deckTools(store, "c1", () => "שיעור");
    const run = (input: Record<string, unknown>) => tool!.run(input, {} as never) as Promise<{ output: string }>;
    await run({ action: "write", title: "חוסמי בטא", theme: "ocean", slides: [{ id: "a", layout: "title", title: "חוסמי בטא" }, { id: "b", title: "איך", bullets: ["β1", "דופק"], image: "javascript:alert(1)" }] });
    let d = (await store.get("chat-c1"))!;
    assert.equal(d.slides.length, 2);
    assert.equal(d.theme, "ocean");
    assert.equal(d.slides[1]!.layout, "bullets");
    assert.equal(d.slides[1]!.image, undefined);
    await run({ action: "change", slide: { id: "b", layout: "two", title: "השוואה", bullets: ["א"], more: ["ב"] } });
    await run({ action: "add", after: "a", slides: [{ title: "מבוא" }] });
    d = (await store.get("chat-c1"))!;
    assert.deepEqual(d.slides.map((s) => s.title), ["חוסמי בטא", "מבוא", "השוואה"]);
    assert.match((await run({ action: "read" })).output, /\[b\] two: השוואה/);
    // The page saves from an old revision: refused.
    await assert.rejects(store.save(d.id, { slides: d.slides, rev: d.rev - 1 }), /changed/);
    const saved = await store.save(d.id, { slides: d.slides.slice(0, 1), rev: d.rev, title: "חדש" });
    assert.equal(saved.slides.length, 1);
    const back = await store.restore(d.id, d.rev);
    assert.equal(back.slides.length, 3);
    assert.deepEqual((await store.list()).map((x) => x.slides), [3]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Knowledge, knowledgeTools, passagesOf, rank, words } from "./knowledge.js";

test("words drop Hebrew prefixes and short bits", () => {
  assert.deepEqual(words("והמשחק בית, a Unity-6"), ["והמשחק", "המשחק", "משחק", "בית", "unity-6"]);
});

test("passages are cut near the size with some overlap", () => {
  const text = Array.from({ length: 40 }, (_, i) => `Sentence number ${i} talks about things.`).join(" ");
  const parts = passagesOf(text, 300);
  assert.ok(parts.length > 4);
  assert.ok(parts.every((p) => p.length <= 320));
});

test("BM25 puts the passage about the question first", () => {
  const hits = rank([{ text: "The cat sat on the mat." }, { text: "Refunds are paid within 14 days of the request." }, { text: "Days are long in summer." }], "refund within how many days");
  assert.match(hits[0]!.text, /Refunds/);
});

test("a folder is indexed, searched with sources, and updated when files change", async () => {
  const data = await mkdtemp(join(tmpdir(), "kesher-kb-"));
  const docs = await mkdtemp(join(tmpdir(), "kesher-docs-"));
  await mkdir(join(docs, "sub"));
  await writeFile(join(docs, "policy.md"), "# Policy\n\nמדיניות החזרים: החזר כספי תוך 14 ימים.");
  await writeFile(join(docs, "sub", "notes.txt"), "The build server is called Atlas.");
  await mkdir(join(docs, "node_modules"));
  await writeFile(join(docs, "node_modules", "x.txt"), "Atlas Atlas Atlas");
  const k = new Knowledge(data);
  const base = await k.save({ name: "Work", folders: [docs] });
  await k.reindex(base.id);
  const hits = await k.search("atlas");
  assert.equal(hits.length, 1);
  assert.match(hits[0]!.source, /notes\.txt/);
  assert.equal((await k.search("החזרים", "work"))[0]?.source, "policy.md");
  const [tool] = knowledgeTools(k);
  assert.match(String((await tool!.run({ query: "Atlas" }, {} as never)).output), /notes\.txt, p\. 1/);
  await writeFile(join(docs, "sub", "notes.txt"), "The build server is now Hermes.");
  await k.reindex(base.id);
  assert.equal((await k.search("atlas")).length, 0);
  assert.equal((await k.list())[0]?.files, 2);
  const again = new Knowledge(data);
  assert.equal((await again.search("hermes")).length, 1);
  k.close();
  again.close();
  await k.remove(base.id);
  assert.equal(knowledgeTools(k).length, 0);
});

test("search by meaning finds a passage that shares no words with the question", async () => {
  const data = await mkdtemp(join(tmpdir(), "kesher-kbv-"));
  const docs = await mkdtemp(join(tmpdir(), "kesher-docsv-"));
  await writeFile(join(docs, "refunds.md"), "Customers may request a reimbursement within fourteen days.");
  await writeFile(join(docs, "office.md"), "The office opens at nine in the morning.");
  // A toy "model": one dimension per idea.
  const ideas = [/reimburse|money back|refund/i, /office|morning|open/i];
  const calls: string[] = [];
  const k = new Knowledge(data, () => ({ id: "toy", embed: async (texts, kind) => (calls.push(kind), texts.map((t) => ideas.map((re) => (re.test(t) ? 1 : 0)))) }));
  const b = await k.save({ name: "Docs", folders: [docs] });
  await k.reindex(b.id);
  assert.equal((await k.list())[0]?.embedded, 2);
  const hits = await k.search("how do I get my money back?");
  assert.equal(hits[0]?.source, "refunds.md");
  assert.ok(calls.includes("doc") && calls.includes("query"));
  k.close();
});

test("vectors from an older embedding model are not used against a new model's question", async () => {
  const data = await mkdtemp(join(tmpdir(), "kesher-kb-"));
  const docs = await mkdtemp(join(tmpdir(), "kesher-docs-"));
  await writeFile(join(docs, "a.txt"), "Reading a file line by line in Python uses a for loop over the file object.");
  await writeFile(join(docs, "b.txt"), "Texture compression settings for the editor icons.");
  // The old model puts every passage right next to any question; the new one has other dimensions.
  let model: { id: string; embed: (t: string[], kind: "query" | "doc") => Promise<number[][]> } = { id: "old", embed: async (t) => t.map(() => [1, 0]) };
  const k = new Knowledge(data, () => model);
  const base = await k.save({ name: "Docs", folders: [docs] });
  await k.reindex(base.id);
  model = { id: "new", embed: async (t) => t.map(() => [0, 0, 1]) };
  const hits = await k.search("python file line by line");
  assert.match(hits[0]!.source, /a\.txt/, "words still find it; the old vectors are left out");
  assert.equal(hits.length, 1);
});

test("pictures: described once by the local vision model and found by search; they wait while a chat works or without one", async () => {
  const data = await mkdtemp(join(tmpdir(), "kesher-kb-"));
  const docs = await mkdtemp(join(tmpdir(), "kesher-docs-"));
  await writeFile(join(docs, "whiteboard.jpg"), Buffer.from([0xff, 0xd8, 0xff, 1, 2, 3]));
  await writeFile(join(docs, "plan.md"), "Release plan");
  let busy = true;
  let seesPictures = false;
  const asked: string[] = [];
  const k = new Knowledge(data, () => undefined, {
    describe: async () => (seesPictures ? async (_d, mime) => (asked.push(mime), "A whiteboard with the sprint goals: ship the inventory screen by Friday.") : undefined),
    busy: () => busy,
  });
  const base = await k.save({ name: "Team", folders: [docs] });
  await k.reindex(base.id);
  assert.equal(asked.length, 0, "a chat is working: the picture waits");
  busy = false;
  await k.reindex(base.id);
  assert.equal(asked.length, 0, "no local vision model: the picture waits");
  seesPictures = true;
  await k.reindex(base.id);
  assert.deepEqual(asked, ["image/jpeg"]);
  const hit = (await k.search("inventory screen friday"))[0];
  assert.equal(hit?.source, "whiteboard.jpg");
  assert.match(hit!.text, /^Picture whiteboard\.jpg: A whiteboard/);
  await k.reindex(base.id);
  assert.equal(asked.length, 1, "described once (until the file changes)");
  k.close();
});

test("an index keeps its vectors in a small binary file, and an old index (vectors in the JSON) still reads", async () => {
  const { mkdtemp, writeFile: write, stat: st } = await import("node:fs/promises");
  const { tmpdir: tmp } = await import("node:os");
  const { join: j } = await import("node:path");
  const { readIndex, writeIndex } = await import("./knowledge.js");
  const dir = await mkdtemp(j(tmp(), "kx-"));
  // Old shape: vectors as JSON numbers.
  await write(j(dir, "b.json"), JSON.stringify({ files: { "a.txt": { mtime: 1, size: 2, passages: [{ source: "a.txt", page: 1, text: "hi", vec: [0.6, 0.8] }, { source: "a.txt", page: 2, text: "no vector" }] } } }));
  const first = await readIndex(dir, "b");
  assert.equal(first.old, true);
  assert.ok(first.ix.files["a.txt"]!.passages[0]!.vec instanceof Float32Array);
  await writeIndex(dir, "b", first.ix);
  const again = await readIndex(dir, "b");
  assert.equal(again.old, false);
  const [p0, p1] = again.ix.files["a.txt"]!.passages;
  assert.deepEqual([...p0!.vec!].map((x) => Math.round(x * 100) / 100), [0.6, 0.8]);
  assert.equal(p1!.vec, undefined);
  assert.equal((await st(j(dir, "b.vec"))).size, 8);
});

test("a base's size counts its index files, and a base without the vectors file still has one", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kb-size-"));
  await writeFile(join(dir, "a.json"), "x".repeat(100));
  const k = new Knowledge(dir);
  assert.equal(await k.baseSize("a"), 100);
  await writeFile(join(dir, "a.vec"), "y".repeat(50));
  assert.equal(await k.baseSize("a"), 150);
  assert.equal(await k.baseSize("none"), 0);
});

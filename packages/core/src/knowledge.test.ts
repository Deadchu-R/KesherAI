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

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PIPELINE_TEMPLATES, Pipelines, fill, validate, type PipelineDeps } from "./pipelines.js";

async function setup(ask: PipelineDeps["ask"]) {
  const dir = await mkdtemp(join(tmpdir(), "kesher-pipes-"));
  const notes: string[] = [];
  const p = new Pipelines(join(dir, "p"), join(dir, "out"), {
    ask,
    knowledge: async (q) => `found: ${q}`,
    image: async () => [{ data: new Uint8Array([1, 2]), mimeType: "image/png" }],
    transcribe: async (path) => `words in ${path}`,
    notify: async (_t, b) => void notes.push(b),
  });
  return { p, dir, notes };
}

test("templates fill and pipelines validate", () => {
  assert.equal(fill("Hi {{name}}, {{ missing }}!", { name: "Roee" }), "Hi Roee, !");
  assert.throws(() => validate({ name: "x", inputs: [], steps: [{ id: "b", type: "break" }] }), /inside a loop/);
  assert.throws(() => validate({ name: "x", inputs: [], steps: [{ id: "a", type: "ask", prompt: "p", output: "bad name" }] }), /output/);
  for (const t of PIPELINE_TEMPLATES) validate(t);
});

test("write → review loop runs until approved, then saves", async () => {
  let reviews = 0;
  const { p, dir } = await setup(async ({ prompt }) => {
    if (/reviewer|APPROVED\. Otherwise/.test(prompt)) return ++reviews < 2 ? "Too short." : "APPROVED";
    if (/Fix these problems/.test(prompt)) return "A longer poem.";
    return "A poem.";
  });
  const saved = await p.save({ ...PIPELINE_TEMPLATES[0]!, name: "Review loop" });
  const run = await p.start(saved.id, { task: "Write a poem" });
  const done = (await p.wait(run.id))!;
  assert.equal(done.status, "done", done.error);
  assert.equal(reviews, 2);
  assert.equal(done.vars.draft, "A longer poem.");
  assert.deepEqual(done.files, ["result.md"]);
  assert.equal(await readFile(join(dir, "out", run.id, "result.md"), "utf8"), "A longer poem.");
});

test("for each line, if/else, break, images, knowledge, transcribe, notify; stop", async () => {
  const { p, notes } = await setup(async ({ prompt }) => (/YES or NO/.test(prompt) ? (/---\nbanana\n---/.test(prompt) ? "YES" : "NO") : `<${prompt}>`));
  const saved = await p.save({
    name: "Mixed",
    inputs: [{ name: "list" }],
    steps: [
      { id: "k", type: "knowledge", query: "q {{list}}", output: "kb" },
      { id: "t", type: "transcribe", path: "/tmp/a.mp3", output: "tr" },
      { id: "acc", type: "set", value: "", output: "acc" },
      {
        id: "each",
        type: "loop",
        mode: "lines",
        over: "{{list}}",
        steps: [
          { id: "stop", type: "if", test: { kind: "equals", text: "{{item}}", value: "end" }, then: [{ id: "b", type: "break" }] },
          { id: "fruit", type: "if", test: { kind: "ask", text: "{{item}}", value: "Is this a banana?" }, then: [{ id: "y", type: "set", value: "{{acc}}B{{index}} ", output: "acc" }], else: [{ id: "n", type: "set", value: "{{acc}}x{{index}} ", output: "acc" }] },
        ],
      },
      { id: "pic", type: "image", prompt: "{{acc}}", output: "img" },
      { id: "bell", type: "notify", message: "done {{acc}}" },
    ],
  });
  const r = (await p.wait((await p.start(saved.id, { list: "- banana\n2. apple\nbanana\nend\nbanana" })).id))!;
  assert.equal(r.status, "done", r.error);
  assert.equal(r.vars.acc, "B1 x2 B3 ");
  assert.equal(r.vars.kb, "found: q - banana\n2. apple\nbanana\nend\nbanana");
  assert.equal(r.vars.tr, "words in /tmp/a.mp3");
  assert.deepEqual(r.files, ["img-1.png"]);
  assert.deepEqual(notes, ["done B1 x2 B3 "]);

  const slow = await p.save({ name: "Slow", inputs: [], steps: [{ id: "l", type: "loop", mode: "times", count: 50, steps: [{ id: "a", type: "ask", prompt: "x", output: "o" }] }] });
  const { p: p2 } = await setup(async (_r, signal) => new Promise((ok, no) => { const t = setTimeout(() => ok("y"), 50); signal.addEventListener("abort", () => (clearTimeout(t), no(new Error("aborted")))); }));
  const saved2 = await p2.save({ ...slow, id: undefined });
  const run2 = await p2.start(saved2.id, {});
  setTimeout(() => p2.stop(run2.id), 120);
  assert.equal((await p2.wait(run2.id))!.status, "stopped");
});

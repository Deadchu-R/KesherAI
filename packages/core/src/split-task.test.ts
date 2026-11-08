import { test } from "node:test";
import assert from "node:assert/strict";
import { runSplit, type SplitWorker } from "./split-task.js";

const worker = (name: string, ms: number, fail = false): SplitWorker => ({
  name,
  modelId: `${name}/m`,
  turn: async (req) => {
    await new Promise((r) => setTimeout(r, ms));
    if (fail) throw new Error("offline");
    const last = req.messages.at(-1) as { content: string };
    return { text: `${name}: ${last.content.split("\n").pop()}`, toolCalls: [] };
  },
});

test("parts run on every computer at once, keep their order, and a failed part moves to another computer", async () => {
  const parts = Array.from({ length: 6 }, (_, i) => ({ title: `p${i}`, task: `do ${i}` }));
  const started = Date.now();
  const r = await runSplit(parts, [worker("pc", 20), worker("laptop", 20)], { signal: new AbortController().signal });
  assert.equal(r.length, 6);
  assert.deepEqual(r.map((x) => x.text.split(": ")[1]), parts.map((p) => p.task));
  assert.ok(new Set(r.map((x) => x.computer)).size === 2, "both computers worked");
  assert.ok(Date.now() - started < 6 * 20, "in parallel");

  const r2 = await runSplit(parts.slice(0, 2), [worker("dead", 1, true), worker("pc", 5)], { signal: new AbortController().signal });
  assert.ok(r2.every((x) => x.ok && x.computer === "pc"));
});

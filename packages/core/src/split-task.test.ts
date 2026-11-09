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

test("each computer gets a model that fits its hardware, and a hot or busy one is skipped", async () => {
  const { pickForHardware, paramsOf } = await import("./split-task.js");
  const GB = 1024 ** 3;
  assert.equal(paramsOf("llamacpp/Qwen3-4B-Q4_K_M"), 4);
  assert.equal(paramsOf("lmstudio/qwen/qwen3-coder-30b"), 30);
  assert.equal(paramsOf("lmstudio/qwen3.5-9b-deepseek-v4-flash"), 9);
  const laptop = { cards: [{ temp: 60, util: 10, memUsed: 2 * GB, memTotal: 6 * GB }], system: { ramUsed: 8 * GB, ramTotal: 16 * GB, cpu: 20 } };
  assert.deepEqual(pickForHardware(["a/qwen3-30b", "a/qwen3-9b", "a/qwen3-4b"], laptop), { model: "a/qwen3-4b" }, "a 6 GB card: the 4B");
  assert.deepEqual(pickForHardware(["a/qwen3-30b", "a/qwen3-4b"], laptop, "a/qwen3-30b"), { model: "a/qwen3-4b" }, "the chat's 30B does not fit the laptop");
  const pc = { cards: [{ temp: 55, util: 5, memUsed: 4 * GB, memTotal: 24 * GB }] };
  assert.deepEqual(pickForHardware(["a/qwen3-30b", "a/qwen3-4b"], pc), { model: "a/qwen3-30b" });
  assert.match(pickForHardware(["a/qwen3-4b"], { ...laptop, cooling: true }).skip ?? "", /cooling/);
  assert.match(pickForHardware(["a/qwen3-4b"], { ...laptop, systemHold: "the processor is 91 °C" }).skip ?? "", /91 °C/);
  assert.match(pickForHardware(["a/qwen3-4b"], { cards: [{ temp: 70, util: 95, memUsed: 1, memTotal: 8 * GB }] }).skip ?? "", /busy/);
  assert.deepEqual(pickForHardware(["a/x"], undefined, "a/x"), { model: "a/x" }, "it did not say: any model");
});

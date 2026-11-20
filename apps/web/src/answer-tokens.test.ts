import { test } from "node:test";
import assert from "node:assert/strict";
import { answerTokens, cachePercent } from "./answer-tokens.js";

const ev = (seq: number, e: { type: string } & Record<string, unknown>) => ({ seq, at: "2026-11-20T00:00:00Z", ...e });
const use = (seq: number, u: Record<string, unknown>) => ev(seq, { type: "usage", modelId: "llamacpp/Qwen-8B.gguf", role: "main", input: 0, output: 0, estimated: false, tools: [], ...u });

test("sums each answer's calls; cache only from the calls that reported it", () => {
  const m = answerTokens([
    ev(1, { type: "user", text: "q" }),
    use(2, { modelId: "router/small", role: "router", input: 100, output: 5 }),
    use(3, { input: 1000, output: 50, cached: 800 }),
    use(4, { input: 1200, output: 70, cached: 1100 }),
    ev(5, { type: "assistant", text: "a" }),
    ev(6, { type: "user", text: "q2" }),
    ev(7, { type: "assistant", text: "no usage" }),
  ]);
  assert.deepEqual(m.get(5), { modelId: "llamacpp/Qwen-8B.gguf", input: 2300, output: 125, cached: 1900, cacheBase: 2200, estimated: false });
  assert.equal(m.has(7), false);
});

test("no cache field when no call reported it; cached never above input", () => {
  const m = answerTokens([ev(1, { type: "user" }), use(2, { input: 10, output: 3, estimated: true }), ev(3, { type: "assistant" }), use(4, { input: 10, output: 1, cached: 50 }), ev(5, { type: "assistant" })]);
  assert.equal(m.get(3)!.cached, undefined);
  assert.equal(m.get(3)!.estimated, true);
  assert.equal(m.get(5)!.cached, 10);
});

test("cache percent", () => {
  assert.equal(cachePercent(1900, 2200), 86);
  assert.equal(cachePercent(undefined, 100), undefined);
  assert.equal(cachePercent(5, 0), undefined);
  assert.equal(cachePercent(500, 100), 100);
});

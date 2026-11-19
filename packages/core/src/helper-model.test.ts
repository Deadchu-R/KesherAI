import { test } from "node:test";
import assert from "node:assert/strict";
import { engineIdOf, helperLimit, maySwap, pickHelperModel, shortModelName, type HelperModelInput } from "./helper-model.js";

const lead27 = { modelId: "llamacpp/Qwen3.8-27B-Q4_K_M", path: "/m/Qwen3.8-27B-Q4_K_M.gguf", sizeGiB: 16 };
const files = [
  { path: "/m/Qwen3.8-27B-Q4_K_M.gguf", name: "Qwen3.8-27B-Q4_K_M.gguf", sizeGiB: 16 },
  { path: "/m/Qwen3-4B-Q4_K_M.gguf", name: "Qwen3-4B-Q4_K_M.gguf", sizeGiB: 2.6 },
  { path: "/m/Qwen3-Coder-30B-A3B-Q4_K_M.gguf", name: "Qwen3-Coder-30B-A3B-Q4_K_M.gguf", sizeGiB: 17.2 },
  { path: "/m/nomic-embed.gguf", name: "nomic-embed-text.gguf", sizeGiB: 0.3 },
];
const base = (kind: HelperModelInput["kind"], over: Partial<HelperModelInput> = {}): HelperModelInput => ({ kind, choice: "auto", vramGiB: 24, lead: lead27, local: files, cloud: [], ...over });

test("24 GB: lookup gets the small model beside the chat's, research inherits, build swaps once", () => {
  const l = pickHelperModel(base("lookup"));
  assert.equal(l.how, "beside");
  assert.equal(l.how === "beside" && l.name, "Qwen3-4B");
  assert.match(l.why.en, /fits beside/);
  const r = pickHelperModel(base("research"));
  assert.equal(r.how, "inherit");
  assert.match(r.why.en, /same as the chat \(Qwen3.8-27B\)/);
  const b = pickHelperModel(base("build"));
  assert.equal(b.how, "swap");
  assert.equal(b.how === "swap" && b.name, "Qwen3-Coder-30B-A3B");
  assert.match(b.why.he, /מחליף פעם אחת/);
});

test("6 GB: lookup never swaps, it runs on the loaded model and says so", () => {
  const lead = { modelId: "llamacpp/Qwen3-8B-Q4", path: "/m/q8.gguf", sizeGiB: 4.8 };
  const p = pickHelperModel(base("lookup", { vramGiB: 6, lead, local: [{ path: "/m/q8.gguf", name: "Qwen3-8B-Q4.gguf", sizeGiB: 4.8 }, files[1]!] }));
  assert.equal(p.how, "inherit");
  assert.equal(p.how === "inherit" && p.noSwap, "Qwen3-4B");
  assert.match(p.why.en, /runs on Qwen3-8B, no swap/);
  // build on the same card: no stronger model fits, so the chat's model
  assert.equal(pickHelperModel(base("build", { vramGiB: 6, lead, local: [files[2]!] })).how, "inherit");
});

test("12 GB: the 30B coder does not fit on the card at all, so a build stays on the chat's model", () => {
  const lead = { modelId: "llamacpp/Qwen3-8B", path: "/m/q8.gguf", sizeGiB: 5 };
  assert.equal(pickHelperModel(base("build", { vramGiB: 12, lead })).how, "inherit");
  assert.equal(pickHelperModel(base("lookup", { vramGiB: 12, lead })).how, "beside");
});

test("no graphics card: everything on the chat's model", () => {
  for (const k of ["lookup", "research", "build"] as const) assert.equal(pickHelperModel(base(k, { vramGiB: 0 })).how, "inherit");
});

test("a small lead model: lookup inherits it", () => {
  const lead = { modelId: "llamacpp/Qwen3-4B", path: "/m/Qwen3-4B-Q4_K_M.gguf", sizeGiB: 2.6 };
  const p = pickHelperModel(base("lookup", { lead }));
  assert.equal(p.how, "inherit");
  assert.match(p.why.en, /already small/);
});

test("a cloud model only when chosen, and a cloud lead keeps the tiers off", () => {
  const p = pickHelperModel(base("build", { choice: "anthropic/claude-sonnet", cloud: ["anthropic/claude-sonnet"] }));
  assert.deepEqual([p.how, p.how === "id" && p.cloud], ["id", true]);
  const cloudLead = pickHelperModel(base("build", { lead: { modelId: "anthropic/claude-sonnet" }, cloud: ["anthropic/claude-sonnet"] }));
  assert.equal(cloudLead.how, "inherit", "auto never picks a cloud model by itself");
});

test("a chosen engine file follows the same swap rule; inherit is the chat's model", () => {
  const id = engineIdOf("Qwen3-Coder-30B-A3B-Q4_K_M.gguf");
  assert.equal(pickHelperModel(base("research", { choice: id })).how, "inherit", "research never swaps");
  assert.equal(pickHelperModel(base("build", { choice: id })).how, "swap");
  assert.equal(pickHelperModel(base("build", { choice: "inherit" })).how, "inherit");
  assert.equal(pickHelperModel(base("lookup", { choice: "strong" })).how, "inherit", "lookup with strong: no swap");
});

test("limits: one at a time on 8 GB or less, two above; the setting is clamped to 1–4", () => {
  assert.equal(helperLimit(0), 1);
  assert.equal(helperLimit(8), 1);
  assert.equal(helperLimit(12), 2);
  assert.equal(helperLimit(24, 9), 4);
  assert.equal(helperLimit(24, 1), 1);
  assert.deepEqual(["lookup", "research", "build", "external"].map((k) => maySwap(k as never)), [false, false, true, false]);
  assert.equal(shortModelName("Qwen3-4B-Q4_K_M.gguf"), "Qwen3-4B");
});

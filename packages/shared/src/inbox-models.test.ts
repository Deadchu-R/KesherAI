import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultFamilyFor, familyOf, isModelUnavailable, matchModel, modelChain, pickableModels, type InboxModel } from "./inbox-models.js";

const PLAN: InboxModel[] = [
  { id: "f", name: "Gemini 3.8 Flash (Medium)", available: true },
  { id: "s", name: "Claude Sonnet 4.6 (Thinking)", available: true },
  { id: "o", name: "Claude Opus 4.6 (Thinking)", available: true },
  { id: "g", name: "GPT-OSS 120B (Medium)", available: true },
  { id: "n", name: "Gemini 4 Neon", available: false },
  { id: "c", name: "Opus with AI credits (overage)", available: true },
];
const task = (o: Partial<{ kind: string; title: string; goal: string; check: string; allowedPaths: string[]; maxFiles: number }> = {}) => ({ title: "Fix", goal: "Fix it", check: "pnpm -s typecheck", allowedPaths: ["apps/**"], maxFiles: 5, ...o });

test("inbox models: defaults by kind (research and code → Opus, small text → Flash)", () => {
  assert.equal(defaultFamilyFor(task({ kind: "research" })), "opus");
  assert.equal(defaultFamilyFor(task()), "opus", "code with a check");
  assert.equal(defaultFamilyFor(task({ title: "Convert the plugin to UE 5.6", check: "" , maxFiles: 1 })), "opus", "a conversion");
  assert.equal(defaultFamilyFor(task({ allowedPaths: ["docs/**", "README.md"] })), "flash", "docs only");
  assert.equal(defaultFamilyFor(task({ check: "", maxFiles: 2 })), "flash", "one or two files without a check");
});

test("inbox models: only available, never paid; fallback Opus → Sonnet → Flash", () => {
  assert.deepEqual(pickableModels(PLAN).map((m) => m.id), ["f", "s", "o", "g"]);
  assert.equal(pickableModels([]).length, 3, "the known names before the agent was asked");
  assert.equal(matchModel(PLAN, "opus")?.id, "o");
  assert.equal(matchModel(PLAN, "Gemini 4 Neon"), undefined);
  assert.deepEqual(modelChain(PLAN, "", "opus").map((m) => m.id), ["o", "s", "f"]);
  assert.deepEqual(modelChain(PLAN, "Claude Sonnet 4.6 (Thinking)", "opus").map((m) => m.id), ["s", "f"]);
  assert.deepEqual(modelChain(PLAN, "GPT-OSS", "opus").map((m) => m.id), ["g", "f"], "others fall back to Flash");
  assert.deepEqual(modelChain(PLAN, "", "flash").map((m) => m.id), ["f"]);
  assert.deepEqual(modelChain([], "", "opus"), []);
  assert.equal(familyOf("Gemini 3.8 Flash-Lite"), undefined);
  assert.ok(isModelUnavailable("RESOURCE_EXHAUSTED: quota"));
  assert.ok(!isModelUnavailable("Internal error"));
});

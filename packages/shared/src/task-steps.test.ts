import assert from "node:assert/strict";
import { test } from "node:test";
import { estimateTaskSteps, researchParts } from "./task-steps.js";

const base = { runBy: "antigravity", maxFiles: 4, goal: "x".repeat(100), check: "" } as const;

test("research parts are the acceptance list items, at least one", () => {
  assert.equal(researchParts(undefined), 1);
  assert.equal(researchParts("no list here"), 1);
  assert.equal(researchParts("- a\n* b\n1. c\n2) d\ntext"), 4);
});

test("a free-Gemini research task: parts (at most 3) x (search + read) + write", () => {
  assert.equal(estimateTaskSteps({ ...base, runBy: "gemini", kind: "research", acceptance: "- a\n- b" }), 5);
  assert.equal(estimateTaskSteps({ ...base, runBy: "gemini", kind: "research", acceptance: "- a\n- b\n- c\n- d\n- e" }), 7);
  assert.equal(estimateTaskSteps({ ...base, runBy: "gemini", kind: "research" }), 3);
});

test("a big research task counts more parts, up to 8", () => {
  assert.equal(estimateTaskSteps({ ...base, kind: "research", acceptance: "- a\n- b\n- c\n- d\n- e" }), 11);
  assert.equal(estimateTaskSteps({ ...base, kind: "research", acceptance: Array.from({ length: 20 }, (_, i) => `- p${i}`).join("\n") }), 17);
});

test("a code task: files, goal length and a check", () => {
  assert.equal(estimateTaskSteps(base), 3 + 4 + 1);
  assert.equal(estimateTaskSteps({ ...base, check: "pnpm -s typecheck" }), 10);
  assert.equal(estimateTaskSteps({ ...base, goal: "x".repeat(1000) }), 3 + 4 + 3);
  assert.equal(estimateTaskSteps({ ...base, maxFiles: 60 }), 3 + 15 + 1);
  assert.equal(estimateTaskSteps({ ...base, runBy: "local", maxFiles: 0, goal: "" }), 4);
});

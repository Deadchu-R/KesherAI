import { test } from "node:test";
import assert from "node:assert/strict";
import { ASSIGN_CHOICES, RELAY_PIN, assignOfExecutor, inboxExecutorOf } from "./task-assign.js";
import { ghostcliCompat } from "./task-inbox.js";

test("GhostCLI is its own executor, and old relay-pinned OpenCode tasks read as GhostCLI's", () => {
  assert.equal(inboxExecutorOf("ghostcli"), "ghostcli");
  assert.equal(inboxExecutorOf("opencode"), "opencode");
  assert.equal(assignOfExecutor("ghostcli"), "ghostcli");
  assert.equal(assignOfExecutor("opencode", RELAY_PIN), "ghostcli");
  assert.equal(assignOfExecutor("opencode", "ghostcli/claude-opus-5-5"), "ghostcli");
  assert.equal(assignOfExecutor("opencode", "opencode-go/mimo-v2.6-pro"), "opencode");
  assert.equal(ghostcliCompat("opencode", RELAY_PIN), "ghostcli");
  assert.equal(ghostcliCompat("opencode", "ghostcli/claude-sonnet-5"), "ghostcli");
  assert.equal(ghostcliCompat("opencode", undefined), "opencode");
  assert.equal(ghostcliCompat("antigravity", RELAY_PIN), "antigravity");
  assert.match(ASSIGN_CHOICES.find((c) => c.to === "ghostcli")!.noteEn, /Code and research/);
});

import { test } from "node:test";
import assert from "node:assert/strict";

test("the relay report counts results and rate limits", async () => {
  const { relayReport } = await import("./task-inbox.js");
  const r = relayReport([
    { at: 1, id: "a", model: "ghostcli/claude-opus-5-5", status: "done", ms: 600_000 },
    { at: 2, id: "b", model: "ghostcli/claude-opus-5-5", status: "rate-limited", ms: 1_000 },
    { at: 3, id: "b", model: "ghostcli/claude-opus-5-5", status: "partial", ms: 1_200_000 },
  ]);
  assert.deepEqual({ runs: r.runs, done: r.done, partial: r.partial, failed: r.failed, rateLimited: r.rateLimited, last: r.lastRateLimitAt, avg: r.avgMinutes, since: r.since, first: r.recent[0]!.id }, { runs: 3, done: 1, partial: 1, failed: 0, rateLimited: 1, last: 2, avg: 15, since: 1, first: "b" });
});

test("heavy tasks without sensitive content may go to the relay", async () => {
  const { safeForRelay, relayProviderOf, inboxModelAllowed, RELAY_PROVIDERS } = await import("./task-inbox.js");
  assert.equal(safeForRelay({ risk: "medium", allowedPaths: ["apps/web/**"], title: "Scene list previews" }).ok, true);
  assert.equal(safeForRelay({ risk: "high", allowedPaths: ["apps/web/**"], title: "x" }).ok, false);
  assert.equal(safeForRelay({ risk: "low", allowedPaths: ["packages/core/src/auth/**"], title: "x" }).ok, false);
  assert.equal(safeForRelay({ risk: "low", allowedPaths: ["apps/**"], title: "Rotate the API token" }).ok, false);
  assert.equal(safeForRelay({ risk: "low", allowedPaths: [], title: "x" }).ok, false);
  assert.equal(relayProviderOf("ghostcli/claude-opus-5-5")?.id, "ghostcli");
  assert.equal(inboxModelAllowed("ghostcli/claude-opus-5-5"), false);
  assert.equal(inboxModelAllowed("ghostcli/claude-opus-5-5", false, true), true);
  assert.deepEqual(RELAY_PROVIDERS[0]!.pick(["ghostcli/claude-haiku-5-5", "ghostcli/claude-sonnet-5", "ghostcli/claude-opus-5-5", "nvidia-nim/x"]), ["ghostcli/claude-opus-5-5", "ghostcli/claude-sonnet-5"]);
});

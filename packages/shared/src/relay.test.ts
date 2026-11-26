import { test } from "node:test";
import assert from "node:assert/strict";
import { isSecurityFile, safeForRelay, safeForTrainingProvider } from "./task-inbox.js";

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

test("check messages are counted apart from tasks", async () => {
  const { relayReport } = await import("./task-inbox.js");
  const r = relayReport([
    { at: 1, id: "probe", model: "ghostcli/claude-opus-5-5", status: "probe-failed", ms: 90_000 },
    { at: 2, id: "probe", model: "ghostcli/claude-opus-5-5", status: "probe-ok", ms: 2_000 },
    { at: 3, id: "a", model: "ghostcli/claude-opus-5-5", status: "done", ms: 60_000 },
  ]);
  assert.deepEqual({ probes: r.probes, ok: r.probesOk, runs: r.runs, since: r.since, recent: r.recent.length }, { probes: 2, ok: 1, runs: 1, since: 3, recent: 1 });
});

test("a wildcard at the top of a path limit is no limit: the relay and training services refuse it", () => {
  for (const g of ["**", "**/*", "*/**", "./**", "/**", "**/*.ts", ""]) {
    assert.equal(safeForRelay({ risk: "low", allowedPaths: [g], title: "Tidy the list" }).ok, false, g);
    assert.equal(safeForTrainingProvider({ kind: "code", risk: "low", size: "S", allowedPaths: [g], title: "Tidy the list" }).ok, false, g);
  }
  assert.equal(safeForRelay({ risk: "low", allowedPaths: ["apps/ui/src/**"], title: "Tidy the list" }).ok, true);
});

test("security files are found on the real changed paths", () => {
  assert.equal(isSecurityFile("packages/core/src/pairing.ts"), true);
  assert.equal(isSecurityFile(".github/workflows/release.yml"), true);
  assert.equal(isSecurityFile("apps/web/src/pages/TaskInboxPage.tsx"), false);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HUB_DIAG_KEEP, mergeDiagEntries, newestDiagLine, parseHubDiag, saveHubDiag, type HubDiagEntry } from "./hub-diag.js";

const entry = (n: number, over: Partial<HubDiagEntry> = {}): HubDiagEntry => ({ at: new Date(Date.UTC(2026, 10, 22, 0, 0, n)).toISOString(), kind: "http", where: "http", method: "POST", path: "/api/ticket", status: 500, code: `c${n}`, message: `m${n}`, ...over });

test("parseHubDiag keeps well-formed entries and refuses anything else", () => {
  assert.equal(parseHubDiag(null), undefined);
  assert.equal(parseHubDiag({ entries: "x" }), undefined);
  const s = parseHubDiag({ now: "n", startedAt: "s", total: 2, entries: [entry(1), { nope: 1 }, 5] });
  assert.equal(s?.entries.length, 1);
});

test("mergeDiagEntries: the same entry once (the later sighting), oldest first, the last 200", () => {
  const first = entry(1, { count: 1 });
  const later = { ...first, at: entry(9).at, count: 5 };
  const merged = mergeDiagEntries([first, entry(2)], [later, entry(3)]);
  assert.deepEqual(merged.map((e) => e.code), ["c2", "c3", "c1"]);
  assert.equal(merged.at(-1)!.count, 5);
  const many = Array.from({ length: HUB_DIAG_KEEP + 30 }, (_, i) => entry(i % 59, { code: `k${i}` }));
  assert.equal(mergeDiagEntries([], many).length, HUB_DIAG_KEEP);
});

test("newestDiagLine says when, what, the status, the code and the message", () => {
  assert.equal(newestDiagLine([]), undefined);
  assert.equal(newestDiagLine([entry(4)]), "hub-diag newest 2026-11-22T00:00:04.000Z POST /api/ticket 500 c4: m4");
});

test("saveHubDiag writes hub-diag.json (merged) and one main.log line only when something is new", () => {
  const dir = mkdtempSync(join(tmpdir(), "kesher-hubdiag-"));
  try {
    const logs = join(dir, "logs");
    const snap = { now: "n", startedAt: "s", total: 1, entries: [entry(1)] };
    assert.match(saveHubDiag(logs, snap, "ticket 500", 1000)!, /^hub-diag newest/);
    saveHubDiag(logs, snap, "every 10 minutes", 2000); // nothing new
    const file = JSON.parse(readFileSync(join(logs, "hub-diag.json"), "utf8")) as { reason: string; entries: HubDiagEntry[] };
    assert.equal(file.reason, "every 10 minutes");
    assert.equal(file.entries.length, 1);
    assert.equal(readFileSync(join(logs, "main.log"), "utf8").trim().split("\n").length, 1);
    // The hub woke up with an empty ring: the saved history stays; a new error adds a line.
    saveHubDiag(logs, { ...snap, entries: [entry(2)] }, "every 10 minutes", 3000);
    const again = JSON.parse(readFileSync(join(logs, "hub-diag.json"), "utf8")) as { entries: HubDiagEntry[] };
    assert.equal(again.entries.length, 2);
    assert.equal(readFileSync(join(logs, "main.log"), "utf8").trim().split("\n").length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

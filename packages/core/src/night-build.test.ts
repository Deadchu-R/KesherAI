import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildScorecard, countIssues, dueSlot, holdReason, KEEP_BUILDS, NightBuilds, NightStore, readSettings, scorecardNote, trimLog, type IdleState, type NightResult, type NightRequest } from "./night-build.js";

const idle: IdleState = { chats: 0, selfWork: false, downloads: 0, updating: false, editorOpen: false };
const at = (h: number, m = 0, day = 22) => new Date(2026, 10, day, h, m);

test("dueSlot: from the set time for five hours, also across midnight", () => {
  assert.equal(dueSlot({ time: "02:00" }, at(1, 59)), undefined);
  assert.equal(dueSlot({ time: "02:00" }, at(2, 0)), "2026-11-22");
  assert.equal(dueSlot({ time: "02:00" }, at(7, 0)), "2026-11-22");
  assert.equal(dueSlot({ time: "02:00" }, at(7, 1)), undefined);
  assert.equal(dueSlot({ time: "23:00" }, at(0, 30)), "2026-11-21");
  assert.equal(dueSlot({ time: "bad" }, at(2)), undefined);
});

test("holdReason: the editor, then anything busy, else idle", () => {
  assert.equal(holdReason(idle), undefined);
  assert.equal(holdReason({ ...idle, editorOpen: true }), "editor");
  assert.equal(holdReason({ ...idle, chats: 1 }), "busy");
  assert.equal(holdReason({ ...idle, guardHold: true }), "busy");
  assert.equal(holdReason({ ...idle, playing: true }), "busy");
});

test("readSettings: bad input falls back, platforms limited to what the PC can build", () => {
  const s = readSettings({ enabled: true, time: "3:05", platforms: ["android", "windows", "x"], smoke: "no", evil: 1 }, undefined, ["windows"]);
  assert.deepEqual(s, { enabled: true, time: "03:05", platforms: ["windows"], smoke: true });
  assert.equal(readSettings({ time: "25:00" }).time, "02:00");
});

test("countIssues ignores summary lines with zero", () => {
  const log = "warning C4100: unused\nWarning: x\nerror C2065: undeclared\n0 error(s), 2 warning(s)\nErrors: 0\nBuild failed";
  assert.deepEqual(countIssues(log), { warnings: 2, errors: 2 });
});

test("trimLog keeps distinct error lines with one line of context, else the tail", () => {
  const log = ["compiling", "a.h(3): error C1: x", "a.h(9): error C1: x", "ok", "fatal: boom"].join("\n");
  const t = trimLog(log);
  assert.equal(t.errors, true);
  assert.equal(t.text.split("\n").length, 3);
  assert.match(t.text, /^compiling/);
  const none = trimLog("one\ntwo");
  assert.deepEqual(none, { text: "one\ntwo", errors: false });
});

const res = (o: Partial<NightResult>): NightResult => ({ id: "i", slot: "2026-11-22", project: "/p/a", name: "A", engine: "unreal", platform: "windows", startedAt: "2026-11-22T00:00:00Z", durationMs: 60_000, ok: true, warnings: 0, errors: 0, changes: [], logFile: "/x", ...o });

test("scorecard: newest per project and platform, failures first, failed smoke counts as failure", () => {
  const c = buildScorecard([res({ id: "old", ok: false, startedAt: "2026-11-21T00:00:00Z" }), res({ id: "new" }), res({ id: "b", name: "B", project: "/p/b", smoke: { ok: false, note: "x" } })])!;
  assert.deepEqual(c.rows.map((r) => [r.id, r.ok]), [["b", false], ["new", true]]);
  assert.equal(c.failed, 1);
  assert.match(scorecardNote(c).body, /✕ B/);
  assert.equal(buildScorecard([]), undefined);
});

test("store keeps the last seven builds per project and removes the rest", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kesher-night-"));
  try {
    const store = new NightStore(join(dir, "s.json"));
    for (let i = 0; i < KEEP_BUILDS + 2; i++) {
      const logFile = join(dir, `${i}.log`);
      await writeFile(logFile, "x");
      await store.add(res({ id: `r${i}`, logFile, startedAt: `2026-11-${String(10 + i).padStart(2, "0")}T00:00:00Z` }));
    }
    const all = await store.results("/p/a");
    assert.equal(all.length, KEEP_BUILDS);
    assert.equal(all.at(-1)!.id, "r2");
    await assert.rejects(readFile(join(dir, "0.log")));
    await store.setSettings("/p/a", { enabled: true, time: "02:00", platforms: ["windows"], smoke: true });
    assert.equal((await new NightStore(join(dir, "s.json")).settings("/p/a")).enabled, true, "settings survive a restart");
    assert.equal((await store.settings("/p/other")).enabled, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

async function loop(o: { now: Date; idle?: IdleState; active?: boolean; ok?: boolean; enabled?: boolean }) {
  const dir = await mkdtemp(join(tmpdir(), "kesher-night-"));
  const store = new NightStore(join(dir, "s.json"));
  if (o.enabled !== false) await store.setSettings("/p/a", { enabled: true, time: "02:00", platforms: ["windows"], smoke: true });
  const runs: NightRequest[] = [];
  const sent: string[] = [];
  let clock = o.now;
  const nb = new NightBuilds({
    store,
    runner: async (r) => { runs.push(r); clock = new Date(clock.getTime() + 41 * 60_000); return o.ok === false ? { ok: false, log: "a.cpp(1): error C1: x" } : { ok: true, log: "warning W1\nok", sizeBytes: 5 * 1024 ** 2, smoke: { ok: true, note: "up" } }; },
    projects: async () => [{ kind: "unreal", name: "A", path: "/p/a" }],
    idle: async () => o.idle ?? idle,
    changes: async () => ({ head: "h".repeat(40), lines: ["abc1234 fix jump"] }),
    outDir: (n, _p, id) => join(dir, n, id),
    notify: (_c, n) => void sent.push(n.title),
    active: () => o.active ?? false,
    now: () => clock,
  });
  return { nb, store, runs, sent, done: () => rm(dir, { recursive: true, force: true }) };
}

test("loop: builds at the set time when idle, keeps the result, holds the scorecard until 07:00", async () => {
  const t = await loop({ now: at(2, 5) });
  try {
    await t.nb.tick();
    assert.equal(t.runs.length, 1);
    const [r] = await t.store.results();
    assert.equal(r!.ok, true);
    assert.equal(r!.warnings, 1);
    assert.equal(r!.durationMs, 41 * 60_000);
    assert.deepEqual(r!.changes, ["abc1234 fix jump"]);
    assert.equal(t.sent.length, 0);
    await t.nb.tick();
    assert.equal(t.runs.length, 1, "one build per night");
    assert.equal(await t.nb.report(at(7, 0)), true);
    assert.match(t.sent[0]!, /Night build ✓ 1/);
    assert.equal(await t.nb.report(at(7, 1)), false, "sent once");
  } finally {
    await t.done();
  }
});

test("loop: the scorecard comes at the first sign of the user after 05:00, not at 03:00", async () => {
  const t = await loop({ now: at(2, 5), active: true });
  try {
    await t.nb.tick();
    assert.equal(t.sent.length, 0);
    assert.equal(await t.nb.report(at(5, 30)), true);
  } finally {
    await t.done();
  }
});

test("loop: waits while the editor is open or the computer is busy, and does not build when off or not yet time", async () => {
  for (const [state, why] of [[{ ...idle, editorOpen: true }, "editor"], [{ ...idle, chats: 2 }, "busy"]] as const) {
    const t = await loop({ now: at(3), idle: state });
    try {
      await t.nb.tick();
      assert.equal(t.runs.length, 0);
      assert.equal(t.nb.status().waiting[(await import("./night-build.js")).projectKey("/p/a")], why);
    } finally {
      await t.done();
    }
  }
  for (const o of [{ now: at(1), enabled: true }, { now: at(3), enabled: false }, { now: at(9) }]) {
    const t = await loop(o);
    try {
      await t.nb.tick();
      assert.equal(t.runs.length, 0);
    } finally {
      await t.done();
    }
  }
});

test("loop: a failed build is a failure on the card and drops its output", async () => {
  const t = await loop({ now: at(2, 5), ok: false });
  try {
    await t.nb.tick();
    const [r] = await t.store.results();
    assert.equal(r!.ok, false);
    assert.equal(r!.outputDir, undefined);
    assert.equal(r!.errors, 1);
    await t.nb.report(at(8));
    assert.match(t.sent[0]!, /✕ 1/);
  } finally {
    await t.done();
  }
});

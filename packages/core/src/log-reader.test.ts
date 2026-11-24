import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkAddedFile, explainPrompt, inboxRunLines, isInside, LogReader, readTail, selfWorkLines, summaryPrompt, usageLines } from "./log-reader.js";
import { parseLog } from "./log-parse.js";

test("isInside: Windows paths in any case and slash; no escape with .. or a sibling prefix", () => {
  assert.equal(isInside("C:\\Users\\me", "c:/users/ME/AppData/x.log", "win32"), true);
  assert.equal(isInside("C:\\Users\\me", "C:\\Users\\me", "win32"), true);
  assert.equal(isInside("C:\\Users\\me", "C:\\Users\\me2\\x.log", "win32"), false);
  assert.equal(isInside("C:\\Users\\me", "C:\\Users\\me\\..\\other\\x.log", "win32"), false);
  assert.equal(isInside("C:\\Users\\me", "D:\\x.log", "win32"), false);
  assert.equal(isInside("/home/me", "/home/me/a/b.log", "linux"), true);
  assert.equal(isInside("/home/me", "/home/Me/a.log", "linux"), false);
  assert.equal(isInside("/home/me", "/etc/passwd", "linux"), false);
});

test("added files: inside home only, real files, not keys, not binary, links resolved", async () => {
  const base = await mkdtemp(join(tmpdir(), "kesher-logs-"));
  try {
    const home = join(base, "home");
    await mkdir(join(home, "game"), { recursive: true });
    await writeFile(join(home, "game", "run.log"), "hello\n");
    await writeFile(join(home, ".env"), "KEY=1\n");
    await writeFile(join(home, "blob.log"), Buffer.from([1, 0, 2, 3]));
    await writeFile(join(base, "outside.log"), "x\n");
    await symlink(join(base, "outside.log"), join(home, "link.log"));
    assert.match(await checkAddedFile(join(home, "game", "run.log"), home, "linux"), /run\.log$/);
    await assert.rejects(checkAddedFile(join(base, "outside.log"), home, "linux"), /home folder/);
    await assert.rejects(checkAddedFile(join(home, "link.log"), home, "linux"), /home folder/);
    await assert.rejects(checkAddedFile(join(home, ".env"), home, "linux"), /key or password/);
    await assert.rejects(checkAddedFile(join(home, "blob.log"), home, "linux"), /not a text/);
    await assert.rejects(checkAddedFile(join(home, "game"), home, "linux"), /folder/);
    await assert.rejects(checkAddedFile("game/run.log", home, "linux"), /full path/);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("readTail drops the partial first line when it starts in the middle", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kesher-logs-"));
  try {
    await writeFile(join(dir, "a.log"), "first line\nsecond\nthird\n");
    const r = await readTail(join(dir, "a.log"), 10);
    assert.equal(r.truncated, true);
    assert.equal(r.text, "third\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("task inbox and self-work runs become log lines with levels", () => {
  const lines = inboxRunLines({
    tasks: [
      { id: "r-1", title: "Fix the hub", runBy: "local", status: "failed", startedAt: 1000, endedAt: 2000, note: "check failed", checks: [{ name: "typecheck", ok: false, note: "2 errors" }] },
      { id: "r-2", title: "Docs", runBy: "antigravity", status: "done", startedAt: 1500, endedAt: 1600 },
    ],
  });
  const e = parseLog(lines.join("\n"));
  assert.deepEqual(e.map((x) => x.level), ["info", "info", "info", "error", "warning"]);
  assert.equal(e[3]!.msg, "r-1 failed: Fix the hub — check failed");
  assert.equal(e[3]!.cat, "inbox");
  assert.deepEqual(inboxRunLines(null), []);
  const sw = parseLog(selfWorkLines({ goal: "t26", status: "blocked", startedAt: 1000, items: [{ at: 2000, text: "t26 done", commit: "abc" }], skipped: [{ at: 3000, why: "tests" }], note: "no model" }).join("\n"));
  assert.deepEqual(sw.map((x) => x.level), ["info", "info", "warning", "error"]);
});

test("the reader: sources, search, patterns with labels that last, new since last look, added files", async () => {
  const base = await mkdtemp(join(tmpdir(), "kesher-logs-"));
  try {
    const root = join(base, "data");
    const home = join(base, "home");
    await mkdir(join(root, "logs"), { recursive: true });
    await mkdir(home, { recursive: true });
    const now = Date.parse("2026-11-24T12:00:00Z");
    await writeFile(join(root, "logs", "main.log"), ["2026-11-24T11:30:00Z [ERROR] Hub answered 502 for /api/x", "2026-11-24T11:40:00Z [ERROR] Hub answered 503 for /api/y", "2026-11-24T11:41:00Z memory ok"].join("\n") + "\n");
    let engine = ["srv load_model: loading", "E: out of memory"];
    const r = new LogReader({ root, home, platform: "linux", env: {}, engineLog: () => engine, now: () => now });
    const ids = (await r.list()).map((s) => s.id);
    assert.ok(ids.includes("kesher-main") && ids.includes("engine-llama"));
    assert.ok(!ids.includes("kesher-faults"));

    assert.equal((await r.search("kesher-main", { q: "hub", levels: ["error"] })).matched, 2);
    await assert.rejects(r.search("nope", {}), /No such log source/);

    const first = await r.patterns("kesher-main");
    const hub = first.patterns.find((p) => p.level === "error")!;
    assert.equal(hub.count, 2);
    assert.equal(hub.isNew, undefined); // the first look marks nothing as new
    assert.equal(await r.setLabel("kesher-main", hub.id, "known"), true);

    // A new kind of line after the look is new; the label is kept (a fresh reader reads it from the file).
    await writeFile(join(root, "logs", "main.log"), "2026-11-24T11:50:00Z [ERROR] Disk full on drive D\n", { flag: "a" });
    const r2 = new LogReader({ root, home, platform: "linux", env: {}, now: () => now });
    const second = await r2.patterns("kesher-main");
    assert.equal(second.patterns.find((p) => p.id === hub.id)!.label, "known");
    assert.equal(second.patterns.find((p) => p.template.startsWith("Disk full"))!.isNew, true);

    const lines = await r2.patternLines("kesher-main", hub.id);
    assert.equal(lines!.entries.length, 2);

    // Only logs written to in the last hour are read for the summary.
    await utimes(join(root, "logs", "main.log"), now / 1000, now / 1000);
    const recent = await r2.recentErrors();
    assert.equal(recent.length, 2);
    const sum = summaryPrompt(recent, true);
    assert.match(sum.system, /עברית/);
    assert.match(sum.user, /Disk full/);
    const ex = explainPrompt("KesherAI log", hub, lines!.entries, false);
    assert.match(ex.user, /Seen 2 times/);

    // Memory logs are parsed again when they change.
    assert.equal((await r.search("engine-llama", { levels: ["error"] })).matched, 1);
    engine = [...engine, "E: again"];
    assert.equal((await r.search("engine-llama", { levels: ["error"] })).matched, 2);

    await writeFile(join(home, "game.log"), "Warning: shader slow\n");
    const added = await r.addFile(join(home, "game.log"));
    assert.equal(added.removable, true);
    assert.equal((await r.search(added.id, {})).hits[0]!.entry.level, "warning");
    assert.equal(await r.removeFile(added.id), true);
    assert.equal(await r.removeFile(added.id), false);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("usage log lines: event, task, model, reason and numbers in the message; executor as the category", () => {
  const [a, b] = parseLog(usageLines(['{"at":1764000000000,"level":"error","executor":"opencode","model":"go/beam-free","task":"r-1","event":"stop","why":"no progress for 20 min","numbers":{"steps":40}}', "not json", '{"at":1764000001000,"level":"suggestion","executor":"local","event":"saving"}'].join("\n")).join("\n"));
  assert.deepEqual([a!.level, a!.cat, a!.msg, a!.t], ["error", "opencode", "stop r-1 (go/beam-free): no progress for 20 min [steps=40]", 1764000000000]);
  assert.deepEqual([b!.level, b!.msg], ["info", "saving (suggestion)"]);
});

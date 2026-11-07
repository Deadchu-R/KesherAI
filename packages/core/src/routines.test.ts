import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Routines, nextRun } from "./routines.js";

test("next run: daily at a time on chosen days, and every N minutes", () => {
  const mon9 = new Date(2026, 10, 9, 9, 0).getTime(); // Monday 9:00
  assert.equal(new Date(nextRun({ kind: "daily", time: "08:30" }, mon9)).getDate(), 10);
  assert.equal(new Date(nextRun({ kind: "daily", time: "10:00" }, mon9)).getHours(), 10);
  const fri = nextRun({ kind: "daily", time: "08:00", days: [5] }, mon9);
  assert.equal(new Date(fri).getDay(), 5);
  assert.equal(nextRun({ kind: "every", minutes: 30 }, mon9, mon9 - 10 * 60_000), mon9 + 20 * 60_000);
});

test("routines run when due, notify, and remember the result", async () => {
  let now = new Date(2026, 10, 9, 7, 59).getTime();
  const notes: string[] = [];
  const asked: string[] = [];
  const r = new Routines(join(await mkdtemp(join(tmpdir(), "kesher-rt-")), "routines.json"), {
    runPipeline: async () => ({ ok: true, message: "pipeline done", link: "#/pipelines" }),
    runPrompt: async (_n, prompt) => (asked.push(prompt), { ok: true, message: "Here is your summary.", link: "#/c/abc" }),
    notify: async (t, b) => void notes.push(`${t}: ${b}`),
  }, () => now);
  const saved = await r.save({ name: "Morning", schedule: { kind: "daily", time: "08:00" }, action: { type: "prompt", prompt: "Summarize my day" } });
  await assert.rejects(r.save({ name: "Bad", schedule: { kind: "daily", time: "25:00" }, action: { type: "prompt", prompt: "x" } }), /08:30/);
  await r.tick();
  assert.deepEqual(asked, [], "not yet");
  now += 2 * 60_000;
  await r.tick();
  assert.deepEqual(asked, ["Summarize my day"]);
  assert.deepEqual(notes, ["✓ Morning: Here is your summary."]);
  const [l] = await r.list();
  assert.equal(l!.lastStatus, "done");
  assert.equal(l!.lastLink, "#/c/abc");
  assert.equal(new Date(l!.nextRun!).getDate(), 10, "tomorrow");
  await r.tick();
  assert.equal(asked.length, 1, "once a day");
  await r.save({ ...saved, enabled: false });
  assert.equal((await r.list())[0]!.nextRun, null);
  r.close();
});

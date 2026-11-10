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

test("a heartbeat speaks only when something needs the user", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kesher-hb-"));
  const notes: string[] = [];
  const discarded: string[] = [];
  const sentToTelegram: string[] = [];
  let answer = "NOTHING";
  let asked = "";
  const r = new Routines(join(dir, "routines.json"), {
    runPipeline: async () => ({ ok: true, message: "", link: "" }),
    runPrompt: async (_n, prompt) => ((asked = prompt), { ok: true, message: answer, link: "#/c/abc" }),
    notify: async (t) => void notes.push(t),
    discard: async (l) => void discarded.push(l),
    telegram: async (t) => void sentToTelegram.push(t),
  });
  const hb = await r.save({ name: "Heartbeat", schedule: { kind: "every", minutes: 30 }, action: { type: "prompt", prompt: "Check my mail", quiet: true }, telegram: true });
  await r.runNow(hb.id);
  assert.match(asked, /answer exactly NOTHING/);
  assert.deepEqual(notes, []);
  assert.deepEqual(discarded, ["#/c/abc"]);
  assert.equal((await r.list())[0]!.lastMessage, "Nothing new.");
  answer = "Your landlord wrote: the rent is due tomorrow.";
  await r.runNow(hb.id);
  assert.equal(notes.length, 1);
  assert.equal(sentToTelegram.length, 1);
  r.close();
});

test("a background routine runs once per start, after a delay, and waits while chats work", async () => {
  let now = new Date(2026, 10, 9, 9, 0).getTime();
  let busy = true;
  const runs: Array<{ prompt: string; opts?: { web?: boolean; folder?: string } }> = [];
  const r = new Routines(join(await mkdtemp(join(tmpdir(), "kesher-rt-")), "routines.json"), {
    runPipeline: async () => ({ ok: true, message: "", link: "" }),
    runPrompt: async (_n, prompt, _m, _p, opts) => (runs.push({ prompt, ...(opts ? { opts } : {}) }), { ok: true, message: "Updated the list.", link: "#/c/x" }),
    notify: async () => undefined,
    busy: () => busy,
  }, () => now);
  await r.save({ name: "Research", schedule: { kind: "startup", delayMinutes: 3 }, action: { type: "prompt", prompt: "Update the list", web: true, folder: "/home/u/Research", background: true } });
  await assert.rejects(r.save({ name: "Bad", schedule: { kind: "startup", delayMinutes: 500 }, action: { type: "prompt", prompt: "x" } }), /0–120/);
  await r.tick();
  assert.equal(runs.length, 0, "not before the delay");
  now += 4 * 60_000;
  await r.tick();
  assert.equal(runs.length, 0, "waits while a chat works");
  busy = false;
  await r.tick();
  assert.deepEqual(runs, [{ prompt: "Update the list", opts: { web: true, folder: "/home/u/Research" } }]);
  now += 24 * 3600_000;
  await r.tick();
  assert.equal(runs.length, 1, "once per start");
  const [l] = await r.list();
  assert.equal(l!.nextRun, null, "next: the next start");
});

test("a self-work routine starts a run with its project, goal and check", async () => {
  const started: unknown[] = [];
  const dir = await (await import("node:fs/promises")).mkdtemp(join((await import("node:os")).tmpdir(), "routines-sw-"));
  const rs = new Routines(join(dir, "routines.json"), {
    runPipeline: async () => ({ ok: true, message: "", link: "" }),
    runPrompt: async () => ({ ok: true, message: "", link: "" }),
    startSelfWork: async (o) => {
      started.push(o);
      return { ok: true, message: "Self-work started on kesher-self/x.", link: "#/code" };
    },
    notify: async () => undefined,
  });
  const r = await rs.save({ name: "Nightly", schedule: { kind: "daily", time: "01:00" }, action: { type: "self-work", repo: "C:/p", goal: "do the [CoolDown] tasks", hours: 8, check: "pnpm test" } });
  await assert.rejects(rs.save({ name: "x", schedule: { kind: "daily", time: "01:00" }, action: { type: "self-work", repo: "", goal: "", hours: 1, check: "" } }), /project/);
  await rs.runNow(r.id);
  assert.deepEqual(started, [{ repo: "C:/p", goal: "do the [CoolDown] tasks", hours: 8, check: "pnpm test" }]);
  assert.equal((await rs.list()).find((x) => x.id === r.id)?.lastStatus, "done");
});

test("a start-up routine waits 6 hours after its last run (restarts for updates are not new days)", async () => {
  const { nextRun } = await import("./routines.js");
  const start = Date.parse("2026-11-10T20:00:00Z");
  const ranOneHourBefore = start - 3_600_000;
  assert.equal(nextRun({ kind: "startup", delayMinutes: 3 }, start, ranOneHourBefore, start), ranOneHourBefore + 6 * 3_600_000);
  assert.equal(nextRun({ kind: "startup", delayMinutes: 3 }, start, start - 7 * 3_600_000, start), start + 3 * 60_000, "long enough ago: 3 minutes after the start");
});

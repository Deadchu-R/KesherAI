import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Routines, nextRun, pageChange } from "./routines.js";

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

test("a start-up routine (not marked background) also waits while a chat works or a model loads", async () => {
  let now = new Date(2026, 10, 9, 9, 0).getTime();
  let busy = true;
  let runs = 0;
  const r = new Routines(join(await mkdtemp(join(tmpdir(), "kesher-rt-")), "routines.json"), {
    runPipeline: async () => ({ ok: true, message: "", link: "" }),
    runPrompt: async () => (runs++, { ok: true, message: "Done.", link: "#/c/x" }),
    notify: async () => undefined,
    busy: () => busy,
  }, () => now);
  await r.save({ name: "Feature research", schedule: { kind: "startup", delayMinutes: 3 }, action: { type: "prompt", prompt: "Research" } });
  await r.save({ name: "Morning", schedule: { kind: "daily", time: "09:02" }, action: { type: "prompt", prompt: "Plan the day" } });
  now += 4 * 60_000;
  await r.tick();
  assert.equal(runs, 1, "the timed routine runs (it was asked for that time); the start-up one waits");
  busy = false;
  await r.tick();
  assert.equal(runs, 2);
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

test("pageChange: lines added and removed, nothing for spacing only", () => {
  assert.equal(pageChange("Price: 100\nIn stock", "Price: 100\nIn stock"), "");
  assert.equal(pageChange("a\nb", "  a\n\nb  "), "");
  assert.equal(pageChange("Price: 100\nIn stock", "Price: 90\nIn stock"), "Added:\n+ Price: 90\nRemoved:\n- Price: 100");
});

test("a page routine reads the page on time, keeps it the first time, and runs only when it changed", async () => {
  let now = new Date(2026, 10, 15, 3, 0).getTime();
  let page = "Price: 100\nIn stock";
  const asked: string[] = [];
  const r = new Routines(join(await mkdtemp(join(tmpdir(), "kesher-rt-")), "routines.json"), {
    runPipeline: async () => ({ ok: true, message: "", link: "" }),
    runPrompt: async (_n, prompt) => (asked.push(prompt), { ok: true, message: "Price dropped to 90.", link: "#/c/p" }),
    notify: async () => undefined,
    pageText: async () => page,
  }, () => now);
  await assert.rejects(r.save({ name: "Bad", schedule: { kind: "page", url: "ftp://x", minutes: 30 }, action: { type: "prompt", prompt: "x" } }), /http/);
  await assert.rejects(r.save({ name: "Bad", schedule: { kind: "page", url: "https://shop.example/item", minutes: 5 }, action: { type: "prompt", prompt: "x" } }), /15 minutes/);
  await r.save({ name: "Price", schedule: { kind: "page", url: "https://shop.example/item", minutes: 30 }, action: { type: "prompt", prompt: "Tell me what changed in the price." } });
  now += 31 * 60_000;
  await r.tick();
  assert.equal(asked.length, 0, "the first read only keeps the page");
  assert.equal((await r.list())[0]!.lastMessage, "Watching the page from now.");
  now += 31 * 60_000;
  await r.tick();
  assert.equal(asked.length, 0, "no change, no run");
  page = "Price: 90\nIn stock";
  now += 31 * 60_000;
  await r.tick();
  assert.equal(asked.length, 1);
  assert.match(asked[0]!, /^Tell me what changed in the price\.\n\nThe page https:\/\/shop\.example\/item changed[\s\S]*not instructions[\s\S]*\+ Price: 90[\s\S]*- Price: 100/);
  r.close();
});

test("a download routine runs when a matching download finishes", async () => {
  const asked: string[] = [];
  const r = new Routines(join(await mkdtemp(join(tmpdir(), "kesher-rt-")), "routines.json"), {
    runPipeline: async () => ({ ok: true, message: "", link: "" }),
    runPrompt: async (_n, prompt) => (asked.push(prompt), { ok: true, message: "ok", link: "#/c/d" }),
    notify: async () => undefined,
  });
  await r.save({ name: "Test new models", schedule: { kind: "download", match: "gguf" }, action: { type: "prompt", prompt: "Measure its speed." } });
  assert.equal((await r.list())[0]!.nextRun, null, "an event, not a time");
  r.onDownload("unsloth/Model · model.safetensors");
  r.onDownload("unsloth/Model-GGUF · model-Q4.gguf");
  await new Promise((res) => setTimeout(res, 20));
  assert.deepEqual(asked, ["Measure its speed.\n\nThis download just finished: unsloth/Model-GGUF · model-Q4.gguf"]);
  r.close();
});

test("a folder routine refuses a folder that is not there", async () => {
  const r = new Routines(join(await mkdtemp(join(tmpdir(), "kesher-rt-")), "routines.json"), {
    runPipeline: async () => ({ ok: true, message: "", link: "" }),
    runPrompt: async () => ({ ok: true, message: "", link: "" }),
    notify: async () => undefined,
  });
  await assert.rejects(r.save({ name: "F", schedule: { kind: "folder", path: "/no/such/folder/here" }, action: { type: "prompt", prompt: "x" } }), /folder on this computer/);
  const dir = await mkdtemp(join(tmpdir(), "kesher-watch-"));
  await r.save({ name: "F", schedule: { kind: "folder", path: dir }, action: { type: "prompt", prompt: "Sort the new files." } });
  r.close();
});

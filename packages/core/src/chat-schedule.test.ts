import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatTimers } from "./chat-timers.js";
import { nextRun, parseSchedule, scheduleText, scheduleTools, SCHEDULED_PER_CHAT, SCHEDULED_TOTAL, type Schedule } from "./chat-schedule.js";

// A zone with daylight saving, so the DST tests mean something (restored at the end of the file's tests).
process.env.TZ = "America/New_York";
const local = (y: number, mo: number, d: number, h = 0, m = 0) => new Date(y, mo - 1, d, h, m).getTime();
const T0 = local(2026, 11, 27, 10, 0); // a Friday
const ok = (t: string, now = T0): Schedule => {
  const s = parseSchedule(t, now);
  assert.equal(typeof s, "object", String(s));
  return s as Schedule;
};

test("parseSchedule reads the grammar, normalises it, and refuses what is outside it", () => {
  assert.equal(scheduleText(ok("Daily 8:30")), "daily 08:30");
  assert.equal(scheduleText(ok("weekdays 09:00")), "weekdays 09:00");
  assert.equal(scheduleText(ok("weekly Monday 18:00")), "weekly mon 18:00");
  assert.equal(scheduleText(ok("every 6 hours")), "every 6 hours");
  assert.equal(scheduleText(ok("every 1 hour")), "every 1 hours");
  assert.deepEqual(ok("2026-12-01T09:00"), { t: "once", at: local(2026, 12, 1, 9) });
  assert.match(String(parseSchedule("every 0 hours", T0)), /once an hour/);
  assert.match(String(parseSchedule("every 500 hours", T0)), /at most 168/);
  assert.match(String(parseSchedule("daily 25:00", T0)), /not a time/);
  assert.match(String(parseSchedule("weekly xyz 10:00", T0)), /not a day/);
  assert.match(String(parseSchedule("weekly m 10:00", T0)), /not a day/);
  assert.match(String(parseSchedule("2020-01-01T09:00", T0)), /passed/);
  assert.match(String(parseSchedule("every minute", T0)), /Give "when"/);
  assert.match(String(parseSchedule(undefined, T0)), /Give "when"/);
});

test("nextRun: daily, weekdays, weekly and every N hours", () => {
  assert.equal(nextRun(ok("daily 11:00"), T0), local(2026, 11, 27, 11));
  assert.equal(nextRun(ok("daily 09:00"), T0), local(2026, 11, 28, 9)); // today's 09:00 has passed
  assert.equal(nextRun(ok("daily 10:00"), T0), local(2026, 11, 28, 10)); // exclusive: not "now"
  assert.equal(nextRun(ok("weekdays 09:00"), T0), local(2026, 11, 30, 9)); // Friday after 9 -> Monday
  assert.equal(nextRun(ok("weekly sun 20:00"), T0), local(2026, 11, 29, 20));
  assert.equal(nextRun(ok("weekly fri 09:00"), T0), local(2026, 12, 4, 9)); // a week on
  assert.equal(nextRun(ok("every 6 hours"), T0), T0 + 6 * 3_600_000);
});

test("nextRun keeps the local time across a daylight-saving change", () => {
  const spring = local(2026, 3, 7, 10, 0); // New York springs forward on 8 March
  const d1 = nextRun(ok("daily 09:00", spring), spring);
  const d2 = nextRun(ok("daily 09:00", spring), d1);
  assert.equal(new Date(d1).getHours(), 9);
  assert.equal(new Date(d2).getHours(), 9);
  assert.equal(d1 - spring, 22 * 3_600_000, "10:00 to 09:00 across the change is 22 hours, not 23");
  // a time the clock skips (02:30) still runs once that day, after the change
  const skipped = nextRun(ok("daily 02:30", spring), local(2026, 3, 8, 0, 30));
  assert.equal(new Date(skipped).getDate(), 8);
  assert.ok(skipped > local(2026, 3, 8, 0, 30) && skipped < local(2026, 3, 9));
  // the autumn change (1 November): 09:00 stays 09:00
  const fall = local(2026, 10, 31, 10, 0);
  assert.equal(new Date(nextRun(ok("daily 09:00", fall), fall)).getHours(), 9);
});

/** Timers with a fake clock and a recording chat. */
async function setup(opts: { create?: boolean } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "kesher-sched-"));
  const state = { now: T0, sent: [] as Array<[string, string]>, marked: [] as string[], n: 0 };
  const timers = new ChatTimers(
    join(dir, "timers.json"),
    {
      send: async (c, t) => void state.sent.push([c, t]),
      exists: async (c) => c !== "gone",
      onCheckBack: (c) => void state.marked.push(c),
      ...(opts.create ? { create: async () => `new${++state.n}` } : {}),
    },
    () => state.now,
  );
  return { timers, state };
}
const sched = (timers: ChatTimers, convId = "c1", when = "daily 11:00", extra: { newChat?: boolean } = {}) => timers.schedule(convId, { name: "News", prompt: "Summarise the news", when, ...extra });

test("a scheduled task fires into its chat as '[KesherAI] Scheduled: <name>', then moves to the next run", async () => {
  const { timers, state } = await setup();
  const t = await sched(timers);
  assert.ok(typeof t !== "string");
  await timers.tick();
  assert.equal(state.sent.length, 0);
  state.now = local(2026, 11, 27, 11, 0) + 1000;
  await timers.tick();
  assert.deepEqual(state.sent, [["c1", "[KesherAI] Scheduled: News\n\nSummarise the news"]]);
  assert.deepEqual(state.marked, ["c1"], "the phone is told when the turn ends");
  const [after] = timers.scheduled("c1");
  assert.equal(after!.due, local(2026, 11, 28, 11));
  assert.equal(after!.lastResult, "ok");
  assert.equal(after!.lastRun, state.now);
});

test("missed while the PC was off: runs once, marked late, never a burst", async () => {
  const { timers, state } = await setup();
  await sched(timers, "c1", "every 1 hours");
  state.now = T0 + 30 * 3_600_000; // thirty runs missed
  await timers.tick();
  await timers.tick();
  assert.equal(state.sent.length, 1);
  assert.match(state.sent[0]![1], /^\[KesherAI\] Scheduled: News \(late/);
  assert.equal(timers.scheduled()[0]!.lastResult, "late");
  assert.equal(timers.scheduled()[0]!.due, state.now + 3_600_000);
});

test("a one-time task runs once and is gone; a paused one does not run and resumes from now", async () => {
  const { timers, state } = await setup();
  const once = await sched(timers, "c1", "2026-11-27T12:00");
  const daily = await sched(timers, "c1", "every 2 hours");
  assert.ok(typeof once !== "string" && typeof daily !== "string");
  await timers.setPaused((daily as { id: string }).id, true);
  state.now = local(2026, 11, 27, 13);
  await timers.tick();
  assert.deepEqual(state.sent.map((x) => x[1].split("\n")[0]), ["[KesherAI] Scheduled: News (late: KesherAI was closed when it was due)"]);
  assert.equal(timers.scheduled().length, 1, "the one-time task is removed");
  await timers.setPaused((daily as { id: string }).id, false);
  assert.equal(timers.scheduled()[0]!.due, state.now + 2 * 3_600_000);
  assert.equal(timers.scheduled()[0]!.paused, undefined);
});

test("Run now fires without moving the schedule; new_chat sends into a fresh chat; a deleted chat drops its tasks", async () => {
  const { timers, state } = await setup({ create: true });
  const a = await sched(timers, "c1", "daily 11:00", { newChat: true });
  assert.ok(typeof a !== "string");
  const due = a.due;
  assert.ok(await timers.runNow(a.id));
  assert.equal(await timers.runNow("nope"), false);
  assert.equal(state.sent[0]![0], "new1");
  assert.deepEqual(state.marked, ["new1"]);
  assert.equal(timers.scheduled()[0]!.due, due);
  await sched(timers, "gone");
  state.now = due + 1000;
  await timers.tick();
  assert.deepEqual(timers.scheduled().map((t) => t.convId), ["c1"], "the deleted chat's task is dropped");
});

test("limits: 10 per chat, 30 in all, a bad `when`; set_timer limits ignore scheduled tasks", async () => {
  const { timers } = await setup();
  for (let i = 0; i < SCHEDULED_PER_CHAT; i++) assert.ok(typeof (await sched(timers)) !== "string");
  assert.match(String(await sched(timers)), /10 scheduled/);
  for (let c = 2; SCHEDULED_TOTAL - timers.scheduled().length > 0; c++) await sched(timers, `c${c}`);
  assert.match(String(await sched(timers, "other")), /30 scheduled/);
  assert.match(String(await sched(timers, "c9", "hourly")), /Give "when"/);
  assert.match(String(await timers.schedule("c9", { name: "", prompt: "x", when: "daily 09:00" })), /name/);
  assert.ok(typeof (await timers.add("c1", "a plain timer", T0 + 60_000)) !== "string", "10 scheduled do not use up the timers' room");
});

test("the tools schedule, list and delete (only this chat's)", async () => {
  const { timers } = await setup();
  const [schedule, list, cancel] = scheduleTools(timers, "c1");
  const r = await schedule!.run({ name: "Build", prompt: "Check the build", when: "weekdays 09:00", new_chat: false }, {} as never);
  assert.match(r.output, /Scheduled "Build" \(weekdays 09:00\)/);
  await assert.rejects(() => schedule!.run({ name: "x", prompt: "y", when: "every 0 hours" }, {} as never), /once an hour/);
  const id = timers.scheduled("c1")[0]!.id;
  assert.match((await list!.run({}, {} as never)).output, new RegExp(`${id}: Build \\(weekdays 09:00\\)`));
  await timers.schedule("c2", { name: "Other", prompt: "p", when: "daily 09:00" });
  await assert.rejects(() => cancel!.run({ id: timers.scheduled("c2")[0]!.id }, {} as never), /no scheduled task/);
  await cancel!.run({ id }, {} as never);
  assert.equal(timers.scheduled("c1").length, 0);
  assert.match((await list!.run({}, {} as never)).output, /No scheduled/);
});

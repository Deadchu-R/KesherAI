import { test } from "node:test";
import assert from "node:assert/strict";
import { SelfWorkWatchdog, WATCHDOG_BACKOFF_MIN, WATCHDOG_DAILY_CAP, watchdogStep, type WatchdogDeps, type WatchdogInput, type WatchdogState } from "./self-work-watchdog.js";

const MIN = 60_000;
const T0 = Date.UTC(2026, 10, 28, 0, 30);
const fresh = (): WatchdogState => ({ attempts: 0, today: 0 });
const failed = (endedAt = T0, note = "The model stopped with errors 3 times in a row."): WatchdogInput["run"] => ({ status: "failed", endedAt, note });
const look = (s: WatchdogState, now: number, run: WatchdogInput["run"], extra: Partial<WatchdogInput> = {}) => watchdogStep(s, { now, localQueued: 4, run, busy: false, date: "2026-11-28", ...extra });

test("watchdog: restarts a failed run after 5, then 15, then 60 minutes, then hands the tasks on", () => {
  let s = fresh();
  let r = look(s, T0 + 4 * MIN, failed());
  assert.equal(r.action.type, "none", "not before the first wait");
  r = look(s, T0 + 5 * MIN, failed());
  assert.equal(r.action.type, "restart");
  assert.match((r.action as { why: string }).why, /failed: The model stopped with errors/);
  s = r.state;
  // The restarted run failed again at once: the next wait counts from the restart.
  assert.equal(look(s, T0 + 5 * MIN + 14 * MIN, failed(T0 + 5 * MIN)).action.type, "none");
  r = look(s, T0 + 5 * MIN + 15 * MIN, failed(T0 + 5 * MIN));
  assert.equal(r.action.type, "restart");
  s = r.state;
  const t2 = T0 + 20 * MIN;
  r = look(s, t2 + 60 * MIN, failed(t2));
  assert.equal(r.action.type, "restart");
  s = r.state;
  assert.equal(s.attempts, WATCHDOG_BACKOFF_MIN.length);
  const t3 = t2 + 60 * MIN;
  assert.equal(look(s, t3 + 59 * MIN, failed(t3)).action.type, "none");
  assert.equal(look(s, t3 + 60 * MIN, failed(t3)).action.type, "handoff", "past the limit the tasks are handed on");
});

test("watchdog: waits while a game or heavy job holds the PC, and does nothing without waiting tasks or while running", () => {
  const s = fresh();
  assert.equal(look(s, T0 + 90 * MIN, failed(), { busy: true }).action.type, "none");
  assert.equal(look(s, T0 + 90 * MIN, failed(), { localQueued: 0 }).action.type, "none");
  assert.equal(look(s, T0 + 90 * MIN, { status: "running" }).action.type, "none");
  assert.equal(look(s, T0 + 90 * MIN, { status: "waiting", note: "Waiting for your approval in the chat." }).action.type, "none");
});

test("watchdog: a run the user stopped is not restarted; its tasks are handed on after the grace", () => {
  const stopped: WatchdogInput["run"] = { status: "stopped", endedAt: T0, note: "Stopped by you." };
  assert.equal(look(fresh(), T0 + 9 * MIN, stopped).action.type, "none");
  assert.equal(look(fresh(), T0 + 10 * MIN, stopped).action.type, "handoff");
  // A run stopped by its time limit is not the user's stop: it restarts.
  assert.equal(look(fresh(), T0 + 5 * MIN, { status: "stopped", endedAt: T0, note: "The time limit was reached." }).action.type, "restart");
});

test("watchdog: no run or a finished goal cannot be resumed: hand on after the first wait; the daily cap hands on too", () => {
  assert.equal(look(fresh(), T0 + 4 * MIN, undefined).action.type, "none");
  assert.equal(look({ ...fresh(), lastAt: T0 }, T0 + 5 * MIN, undefined).action.type, "handoff");
  assert.equal(look(fresh(), T0 + 5 * MIN, { status: "done", endedAt: T0 }).action.type, "handoff");
  const capped = { attempts: 1, today: WATCHDOG_DAILY_CAP, day: "2026-11-28", lastAt: T0 };
  assert.equal(look(capped, T0 + 60 * MIN, failed()).action.type, "handoff");
  // A new day starts the count again.
  assert.equal(look({ ...capped, attempts: 0 }, T0 + 5 * MIN, failed(), { date: "2026-11-29" }).action.type, "restart");
});

test("watchdog: a restarted run that works for 30 minutes is healthy: the backoff starts over", () => {
  let s: WatchdogState = { attempts: 2, today: 2, day: "2026-11-28" };
  s = look(s, T0, { status: "running" }).state;
  s = look(s, T0 + 29 * MIN, { status: "running" }).state;
  assert.equal(s.attempts, 2);
  s = look(s, T0 + 30 * MIN, { status: "running" }).state;
  assert.equal(s.attempts, 0);
});

function harness(run: () => WatchdogInput["run"], o: { queued?: number; busy?: boolean; failRestart?: boolean } = {}) {
  let now = T0;
  const calls: string[] = [];
  const notes: string[] = [];
  let moved = 3;
  const d: WatchdogDeps = {
    now: () => now,
    localQueued: async () => o.queued ?? 4,
    run: async () => run(),
    busy: async () => o.busy ?? false,
    restart: async (why) => {
      calls.push(`restart ${why}`);
      if (o.failRestart) throw new Error("no");
    },
    handOff: async (why) => {
      calls.push(`handoff ${why}`);
      return moved;
    },
    notify: (title, body) => void notes.push(`${title}: ${body}`),
  };
  return { dog: new SelfWorkWatchdog(d), calls, notes, at: (m: number) => void (now = T0 + m * MIN), setMoved: (n: number) => void (moved = n) };
}

test("watchdog: restarts once with one phone note, then hands the tasks on when it stays down", async () => {
  const h = harness(() => failed());
  await h.dog.tick();
  assert.equal(h.calls.length, 0);
  h.at(5);
  await h.dog.tick();
  assert.deepEqual(h.calls.map((c) => c.split(" ")[0]), ["restart"]);
  assert.equal(h.notes.length, 1);
  assert.match(h.notes[0]!, /^Self-work restarted: Self-work restarted: failed/);
  // Down again: the later restarts and the handoff.
  h.at(20);
  await h.dog.tick();
  h.at(80);
  await h.dog.tick();
  h.at(100);
  assert.equal((await h.dog.tick()).type, "none", "waits its last wait");
  h.at(140);
  assert.equal((await h.dog.tick()).type, "handoff");
  assert.match(h.calls.at(-1)!, /^handoff self-work stayed down/);
  assert.match(h.notes.at(-1)!, /3 task\(s\) moved/);
});

test("watchdog: a restart that throws is counted and tried again after the next wait", async () => {
  const h = harness(() => failed(), { failRestart: true });
  h.at(5);
  await h.dog.tick();
  assert.equal(h.notes.length, 0, "no \"restarted\" note for a restart that failed");
  assert.equal(h.dog.state.attempts, 1);
  h.at(10);
  await h.dog.tick();
  assert.equal(h.calls.length, 1, "the next try waits its 15 minutes");
});

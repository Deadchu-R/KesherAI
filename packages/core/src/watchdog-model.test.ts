import { test } from "node:test";
import assert from "node:assert/strict";
import { IDLE_MS, SLOW_MS, WatchdogModel, type WatchEngine } from "./watchdog-model.js";

/** A fake engine that records loads and stops, with a settable answer time on a fake clock. */
function setup(o: { file?: string | undefined; second?: boolean; slowMs?: number } = {}) {
  let now = 0;
  const events: string[] = [];
  let idle: (() => void) | undefined;
  const logs: string[] = [];
  const m = new WatchdogModel({
    modelPath: async () => ("file" in o ? o.file : "router.gguf"),
    make: (cpu) => {
      if (o.second === false) return undefined;
      const e: WatchEngine = {
        load: async (f) => void events.push(`load ${cpu ? "cpu" : "gpu"} ${f}`),
        stop: async (r) => void events.push(`stop ${r}`),
        ask: async () => {
          now += cpu ? (o.slowMs ?? 100) : 100;
          return '{"state":"ok","why":""}';
        },
      };
      return e;
    },
    now: () => now,
    setTimer: (fn) => ((idle = fn), 1),
    clearTimer: () => void (idle = undefined),
    log: (l) => logs.push(l),
  });
  return { m, events, logs, fireIdle: () => idle?.(), hasIdle: () => !!idle };
}
const sig = new AbortController().signal;

test("watchdog model: loads on the CPU for a check, stays for the idle window, then unloads", async () => {
  const s = setup();
  assert.match((await s.m.ask("s", "p", sig))!, /ok/);
  assert.deepEqual(s.events, ["load cpu router.gguf"]);
  assert.equal(s.hasIdle(), true);
  await s.m.ask("s", "p", sig); // a second check reuses it
  assert.deepEqual(s.events, ["load cpu router.gguf"]);
  s.fireIdle();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(s.events, ["load cpu router.gguf", "stop idle"]);
  await s.m.ask("s", "p", sig);
  assert.equal(s.events.length, 3); // loaded again for the next check
  assert.ok(IDLE_MS <= 60_000);
});

test("watchdog model: a CPU answer over 20 s moves the next checks to the GPU", async () => {
  const s = setup({ slowMs: SLOW_MS + 1 });
  await s.m.ask("s", "p", sig);
  assert.equal(s.m.gpu, true);
  assert.deepEqual(s.events, ["load cpu router.gguf", "stop slow on the CPU"]);
  await s.m.ask("s", "p", sig);
  assert.equal(s.events.at(-1), "load gpu router.gguf");
});

test("watchdog model: no model file or no second instance skips the check and logs once", async () => {
  const none = setup({ file: undefined });
  assert.equal(await none.m.ask("s", "p", sig), undefined);
  assert.equal(await none.m.ask("s", "p", sig), undefined);
  assert.equal(none.logs.length, 1);
  assert.deepEqual(none.events, []);
  const noSecond = setup({ second: false });
  assert.equal(await noSecond.m.ask("s", "p", sig), undefined);
  assert.equal(await noSecond.m.ask("s", "p", sig), undefined);
  assert.equal(noSecond.logs.length, 1);
});

test("watchdog model: reuses an already loaded router model when no second instance can run", async () => {
  let now = 0;
  const m = new WatchdogModel({ modelPath: async () => "r.gguf", make: () => undefined, loaded: () => async () => "reused", now: () => now, log: () => undefined });
  assert.equal(await m.ask("s", "p", sig), "reused");
  now += 1;
});

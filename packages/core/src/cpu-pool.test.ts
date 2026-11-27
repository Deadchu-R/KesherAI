import { test } from "node:test";
import assert from "node:assert/strict";
import { CpuPool, type CpuRole, type PoolSettings, type RoleSpec } from "./cpu-pool.js";

/** A fake engine: records loads and unloads; loads finish at once. */
function fakeEngine() {
  const calls: string[] = [];
  return {
    calls,
    engine: {
      load: async (role: CpuRole, _spec: RoleSpec, threads: number) => void calls.push(`load ${role} t${threads}`),
      unload: async (role: CpuRole) => void calls.push(`unload ${role}`),
    },
  };
}

/** A job that ends when the test says so. */
function gate() {
  let open!: () => void;
  const done = new Promise<void>((r) => (open = r));
  return { open, job: async () => done };
}

/** Fake timers: run by hand. */
function timers() {
  const list = new Map<number, () => void>();
  let id = 0;
  return {
    setTimer: (fn: () => void) => (list.set(++id, fn), id),
    clearTimer: (t: unknown) => void list.delete(t as number),
    fireAll: () => {
      const fns = [...list.values()];
      list.clear();
      for (const f of fns) f();
    },
    size: () => list.size,
  };
}

const flush = () => new Promise((r) => setImmediate(r));

function makePool(over: Partial<PoolSettings> = {}, ram: Partial<Record<CpuRole, number>> = {}) {
  const e = fakeEngine();
  const t = timers();
  const settings: PoolSettings = { maxGenerating: 2, ramBudgetMb: 4000, idleMinutes: { chat: 5, watchdog: 1, translator: 5, embeddings: 5 }, ...over };
  const pool = new CpuPool({
    engine: e.engine,
    spec: (role) => ({ file: `/m/${role}.gguf`, ramMb: ram[role] ?? 1000 }),
    settings: () => settings,
    cores: 16,
    setTimer: t.setTimer,
    clearTimer: t.clearTimer,
  });
  return { pool, e, t, settings };
}

test("at most maxGenerating jobs run at once; the rest wait in priority order", async () => {
  const { pool } = makePool({ maxGenerating: 1 });
  const order: string[] = [];
  const first = gate();
  const a = pool.run("embeddings", async () => (order.push("embeddings 1"), first.job()));
  await flush();
  const b = pool.run("embeddings", async () => void order.push("embeddings 2"));
  const c = pool.run("translator", async () => void order.push("translator"));
  const d = pool.run("chat", async () => void order.push("chat"));
  await flush();
  assert.equal(pool.status().running, 1);
  assert.equal(pool.status().roles.find((r) => r.role === "embeddings")?.queued, 1);
  first.open();
  await Promise.all([a, b, c, d]);
  assert.deepEqual(order, ["embeddings 1", "chat", "translator", "embeddings 2"]);
});

test("threads: physical cores less two, split among the jobs at once", async () => {
  const { pool, e } = makePool({ maxGenerating: 2 });
  assert.equal(pool.threadsBudget, 14);
  await pool.run("watchdog", async () => undefined);
  assert.deepEqual(e.calls, ["load watchdog t7"]);
});

test("a game pauses background roles; the interactive one runs with half the threads", async () => {
  const { pool, e } = makePool();
  pool.setPlaying(true);
  let ran = false;
  const bg = pool.run("translator", async () => void (ran = true));
  await pool.run("chat", async () => undefined);
  await flush();
  assert.equal(ran, false);
  assert.ok(e.calls.includes("load chat t3"));
  assert.equal(pool.status().playing, true);
  pool.setPlaying(false);
  await bg;
  assert.equal(ran, true);
});

test("when a game starts, an idle model with too many threads is unloaded", async () => {
  const { pool, e } = makePool();
  await pool.run("chat", async () => undefined);
  pool.setPlaying(true);
  await flush();
  assert.ok(e.calls.includes("unload chat"));
  await pool.run("chat", async () => undefined);
  assert.equal(e.calls.at(-1), "load chat t3");
});

test("idle unload after the role's minutes; 0 keeps it loaded", async () => {
  const { pool, e, t, settings } = makePool();
  settings.idleMinutes.translator = 0;
  await pool.run("watchdog", async () => undefined);
  await pool.run("translator", async () => undefined);
  assert.equal(t.size(), 1);
  t.fireAll();
  await flush();
  assert.ok(e.calls.includes("unload watchdog"));
  assert.ok(!e.calls.includes("unload translator"));
  assert.equal(pool.status().roles.find((r) => r.role === "translator")?.state, "loaded");
});

test("RAM budget: an idle lower role is unloaded to make room; a busy one makes the job wait", async () => {
  const { pool, e } = makePool({ ramBudgetMb: 2500 }, { chat: 1500, embeddings: 1500, watchdog: 1500 });
  await pool.run("embeddings", async () => undefined);
  await pool.run("chat", async () => undefined);
  assert.ok(e.calls.includes("unload embeddings"));
  // chat is busy now: the watchdog cannot fit until it ends.
  const g = gate();
  const busy = pool.run("chat", g.job);
  await flush();
  let ran = false;
  const w = pool.run("watchdog", async () => void (ran = true));
  await flush();
  assert.equal(ran, false);
  assert.equal(pool.status().roles.find((r) => r.role === "watchdog")?.queued, 1);
  g.open();
  await Promise.all([busy, w]);
  assert.equal(ran, true);
  assert.ok(e.calls.includes("unload chat"));
});

test("a model bigger than the whole budget is refused", async () => {
  const { pool } = makePool({ ramBudgetMb: 500 });
  await assert.rejects(pool.run("chat", async () => undefined), /memory budget/);
});

test("tokens a second from the job's report; a cancelled wait leaves the queue", async () => {
  let now = 0;
  const e = fakeEngine();
  const pool = new CpuPool({ engine: e.engine, spec: () => ({ file: "C:\\m\\small.gguf", ramMb: 100 }), settings: () => ({ maxGenerating: 1, ramBudgetMb: 1000, idleMinutes: { chat: 0, watchdog: 0, translator: 0, embeddings: 0 } }), cores: 8, now: () => now });
  await pool.run("translator", async (ctx) => {
    now += 2000;
    ctx.report(50);
  });
  const st = pool.status().roles.find((r) => r.role === "translator")!;
  assert.equal(st.tps, 25);
  assert.equal(st.model, "small.gguf");
  const g = gate();
  const busy = pool.run("chat", g.job);
  await flush();
  const ac = new AbortController();
  const waiting = pool.run("watchdog", async () => undefined, ac.signal);
  await flush();
  ac.abort();
  await assert.rejects(waiting, /Cancelled/);
  assert.equal(pool.status().roles.find((r) => r.role === "watchdog")?.queued, 0);
  g.open();
  await busy;
});

test("a failed load fails the job and frees the role", async () => {
  const pool = new CpuPool({
    engine: { load: async () => Promise.reject(new Error("bad file")), unload: async () => undefined },
    spec: () => ({ file: "/m/x.gguf", ramMb: 100 }),
    settings: () => ({ maxGenerating: 2, ramBudgetMb: 1000, idleMinutes: { chat: 0, watchdog: 0, translator: 0, embeddings: 0 } }),
    cores: 8,
  });
  await assert.rejects(pool.run("watchdog", async () => undefined), /bad file/);
  const st = pool.status();
  assert.equal(st.running, 0);
  assert.equal(st.roles.find((r) => r.role === "watchdog")?.state, "unloaded");
});

test("no model for a role: refused without waiting", async () => {
  const pool = new CpuPool({ engine: fakeEngine().engine, spec: () => undefined, settings: () => ({ maxGenerating: 2, ramBudgetMb: 1000, idleMinutes: { chat: 0, watchdog: 0, translator: 0, embeddings: 0 } }), cores: 8 });
  await assert.rejects(pool.run("translator", async () => undefined), /No translator model/);
});

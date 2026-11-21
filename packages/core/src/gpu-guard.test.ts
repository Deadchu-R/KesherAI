import { test } from "node:test";
import assert from "node:assert/strict";
import { ProviderRegistry } from "@kesher/providers";
import { GpuGuard, GUARD_DEFAULTS, parseSmi, shouldCool, type GuardConfig } from "./gpu-guard.js";

const SMI = "0, NVIDIA GeForce RTX 3090, 71, 98, 20480, 24576, 310.52, 350.00\n1, NVIDIA GeForce RTX 4070, 55, 3, 900, 12282, [N/A], [N/A]\n";

test("parseSmi reads every card, and leaves out power a card does not report", () => {
  const cards = parseSmi(SMI);
  assert.equal(cards.length, 2);
  assert.deepEqual(cards[0], { index: 0, name: "NVIDIA GeForce RTX 3090", temp: 71, util: 98, memUsed: 20480 * 1024 ** 2, memTotal: 24576 * 1024 ** 2, power: 310.52, powerLimit: 350 });
  assert.equal(cards[1]!.power, undefined);
  assert.deepEqual(parseSmi("garbage\n"), []);
});

test("shouldCool starts at the limit and ends only under the resume temperature", () => {
  const at = (temp: number) => [{ index: 0, name: "x", temp, util: 0, memUsed: 0, memTotal: 1 }];
  const cfg = { maxTemp: 83, resumeTemp: 75 };
  assert.equal(shouldCool(at(82), cfg, false), false);
  assert.equal(shouldCool(at(83), cfg, false), true);
  assert.equal(shouldCool(at(78), cfg, true), true);
  assert.equal(shouldCool(at(74), cfg, true), false);
  assert.equal(shouldCool([], cfg, true), false);
});

test("hot card holds new work until it cools; pause holds it too", async () => {
  let temp = 90;
  const cfg: GuardConfig = { ...GUARD_DEFAULTS, unloadAfterMinutes: 0 };
  const notes: string[] = [];
  const guard = new GpuGuard(() => cfg, async () => `0, RTX, ${temp}, 50, 1000, 24000, 200, 350`, (t) => notes.push(t));
  await guard.check();
  assert.equal(guard.status().cooling, true);
  assert.match(notes[0]!, /90 °C/);

  let started = false;
  const p = guard.before("llamacpp").then(() => (started = true));
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(started, false);
  assert.equal(guard.status().waiting, 1);
  temp = 70;
  await guard.check();
  await p;
  assert.equal(started, true);
  assert.equal(guard.status().running, 1);
  guard.after();

  guard.setPaused(true);
  const ac = new AbortController();
  const waiting = guard.before("llamacpp", ac.signal);
  ac.abort();
  await assert.rejects(waiting, /Cancelled/);
  const later = guard.before("llamacpp");
  guard.setPaused(false);
  await later;
  guard.after();
  assert.equal(guard.status().running, 0);
});

test("an idle model is unloaded and comes back by itself on the next request", async () => {
  let loaded = true;
  let reloads = 0;
  const cfg: GuardConfig = { ...GUARD_DEFAULTS, unloadAfterMinutes: 1 };
  const guard = new GpuGuard(() => cfg, async () => { throw new Error("no nvidia-smi"); });
  guard.add({ name: "chat model", providers: ["llamacpp"], loaded: () => loaded, unload: async () => void (loaded = false), reload: async () => void ((loaded = true), reloads++), pids: () => [] });
  await guard.check();
  assert.equal(loaded, true, "used recently: stays");
  ago(guard, 2 * 60_000);
  await guard.check();
  assert.equal(loaded, false);
  assert.equal(guard.status().lastUnload?.what, "chat model");
  await guard.before("other");
  guard.after();
  assert.equal(reloads, 0, "another provider does not load it");
  await guard.before("llamacpp");
  guard.after();
  assert.equal(reloads, 1);
  assert.equal(loaded, true);
});

/** Moves every engine's last use `ms` into the past. */
function ago(guard: GpuGuard, ms: number): void {
  const used = (guard as unknown as { usedAt: Map<unknown, number> }).usedAt;
  for (const k of used.keys()) used.set(k, Date.now() - ms);
}

test("load on demand: each engine has its own idle time, 0 keeps it, and busy or running work is never unloaded", async () => {
  const cfg: GuardConfig = { ...GUARD_DEFAULTS, enabled: false, unloadAfterMinutes: 10 };
  const guard = new GpuGuard(() => cfg, async () => { throw new Error("no nvidia-smi"); });
  const state = { chat: true, embed: true, comfy: true, keep: true };
  let embedBusy = true;
  let embedLast = 0;
  guard.add({ name: "chat model", providers: ["llamacpp"], loaded: () => state.chat, unload: async () => void (state.chat = false), pids: () => [], idleMinutes: () => cfg.unloadAfterMinutes });
  guard.add({ name: "search by meaning", providers: ["llamacpp-embed"], loaded: () => state.embed, unload: async () => void (state.embed = false), pids: () => [], idleMinutes: () => 5, busy: () => embedBusy, lastUsed: () => embedLast });
  guard.add({ name: "ComfyUI", providers: ["comfyui"], loaded: () => state.comfy, unload: async () => void (state.comfy = false), pids: () => [], idleMinutes: () => 5 });
  guard.add({ name: "kept", providers: ["x"], loaded: () => state.keep, unload: async () => void (state.keep = false), pids: () => [], idleMinutes: () => 0 });
  ago(guard, 6 * 60_000);
  // A ComfyUI job runs: nothing is unloaded in the middle of work.
  await guard.before("comfyui");
  await guard.check();
  assert.deepEqual(state, { chat: true, embed: true, comfy: true, keep: true });
  guard.after("comfyui");
  await guard.check();
  assert.equal(state.comfy, true, "just used: stays");
  ago(guard, 6 * 60_000);
  // Six idle minutes (the guard's temperature switch off): ComfyUI goes, the busy embedder and the chat model (10) stay.
  await guard.check();
  assert.deepEqual(state, { chat: true, embed: true, comfy: false, keep: true });
  // The embedder used itself a moment ago: still stays once it is not busy.
  embedBusy = false;
  embedLast = Date.now();
  await guard.check();
  assert.equal(state.embed, true);
  embedLast = Date.now() - 6 * 60_000;
  await guard.check();
  assert.equal(state.embed, false);
  ago(guard, 11 * 60_000);
  await guard.check();
  assert.equal(state.chat, false);
  assert.equal(state.keep, true, "0 minutes = keep loaded");
});

test("the registry sends only local providers' work through the gate", async () => {
  const registry = new ProviderRegistry();
  const calls: string[] = [];
  const make = (location: "local" | "cloud") => ({
    type: location,
    displayName: location,
    categories: ["chat" as const],
    create: (c: { id: string }) => ({
      id: c.id,
      name: c.id,
      location,
      checkHealth: async () => true,
      listModels: async () => [],
      async *chat() {
        calls.push(`chat ${c.id}`);
        yield { type: "done" as const };
      },
      generateImage: async () => (calls.push(`image ${c.id}`), []),
    }),
  });
  registry.registerFactory(make("local") as never);
  registry.registerFactory(make("cloud") as never);
  registry.add({ id: "here", type: "local", name: "here" } as never);
  registry.add({ id: "away", type: "cloud", name: "away" } as never);
  registry.setGate({ before: async (id) => void calls.push(`before ${id}`), after: () => void calls.push("after") });
  for await (const _ of registry.get("here")!.chat!({} as never)) void _;
  await registry.get("here")!.generateImage!({} as never);
  for await (const _ of registry.get("away")!.chat!({} as never)) void _;
  assert.deepEqual(calls, ["before here", "chat here", "after", "before here", "image here", "after", "chat away"]);
});

test("memory, processor and processor temperature limits hold new work, with room before going on", async () => {
  const { systemHold } = await import("./gpu-guard.js");
  const GB = 1024 ** 3;
  const cfg = { maxRamPercent: 90, maxCpuPercent: 0, maxCpuTemp: 85 };
  assert.equal(systemHold({ ramUsed: 8 * GB, ramTotal: 16 * GB, cpu: 99 }, cfg), undefined, "processor limit off");
  assert.match(systemHold({ ramUsed: 15 * GB, ramTotal: 16 * GB, cpu: 10 }, cfg) ?? "", /memory \(RAM\) is 94%/);
  assert.match(systemHold({ ramUsed: 14.1 * GB, ramTotal: 16 * GB, cpu: 10 }, cfg, "was") ?? "", /memory/, "goes on only 5 points lower");
  assert.match(systemHold({ ramUsed: 4 * GB, ramTotal: 16 * GB, cpu: 10, cpuTemp: 88 }, cfg) ?? "", /88 °C/);
  assert.equal(systemHold({ ramUsed: 4 * GB, ramTotal: 16 * GB, cpu: 10, cpuTemp: 77 }, cfg, "was"), undefined);
  let mem = { used: 15.5 * GB, total: 16 * GB };
  const notes: string[] = [];
  const g = new GpuGuard(() => ({ ...GUARD_DEFAULTS, maxRamPercent: 90 }), async () => { throw new Error("no card"); }, (t) => notes.push(t), async () => undefined, () => mem);
  await g.check();
  assert.match(g.status().systemHold ?? "", /memory/);
  const started = g.before("local");
  let ran = false;
  void started.then(() => (ran = true));
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(ran, false, "waits while memory is short");
  mem = { used: 6 * GB, total: 16 * GB };
  await g.check();
  await started;
  g.after();
  assert.equal(ran, true);
  assert.match(notes.join("\n"), /New local work waits: memory/);
});

test("othersBusy: the card working hard with none of our work running means another program uses it", async () => {
  let util = 90;
  const g = new GpuGuard(() => ({ ...GUARD_DEFAULTS }), async () => `0, RTX, 60, ${util}, 1000, 24000, 200, 350`);
  await g.check();
  assert.equal(g.othersBusy(), true);
  util = 10;
  await g.check();
  assert.equal(g.othersBusy(), false);
});

test("load on demand: work that starts while an earlier engine unloads keeps the next one loaded (scan 171)", async () => {
  const cfg: GuardConfig = { ...GUARD_DEFAULTS, enabled: false };
  const guard = new GpuGuard(() => cfg, async () => { throw new Error("no nvidia-smi"); });
  const state = { comfy: true, embed: true };
  let embedBusy = false;
  // ComfyUI's unload is slow; a search starts meanwhile (the embedder turns busy).
  guard.add({ name: "ComfyUI", providers: ["comfyui"], loaded: () => state.comfy, unload: async () => { embedBusy = true; state.comfy = false; }, pids: () => [], idleMinutes: () => 5 });
  guard.add({ name: "search by meaning", providers: ["llamacpp-embed"], loaded: () => state.embed, unload: async () => void (state.embed = false), pids: () => [], idleMinutes: () => 5, busy: () => embedBusy });
  ago(guard, 6 * 60_000);
  await guard.check();
  assert.deepEqual(state, { comfy: false, embed: true });
});

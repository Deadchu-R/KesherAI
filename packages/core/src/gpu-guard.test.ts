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
  (guard as unknown as { lastActive: number }).lastActive = Date.now() - 2 * 60_000;
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

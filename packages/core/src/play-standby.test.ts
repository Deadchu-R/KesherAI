import { test } from "node:test";
import assert from "node:assert/strict";
import { PlayStandby, type StandbyTarget } from "./play-standby.js";
import { GpuGuard, GUARD_DEFAULTS, type Unloadable } from "./gpu-guard.js";

/** A fake guard that records what the state machine asked of it. */
function fake(running = 0) {
  const t = {
    running,
    held: false,
    loaded: ["chat model", "ComfyUI"],
    log: [] as string[],
    runningCount() { return this.running; },
    holdForPlay(on: boolean) { this.held = on; this.log.push(`hold ${on}`); },
    async unloadLoaded() { const l = this.loaded; this.loaded = []; this.log.push("unload"); return l; },
    async reloadNamed(names: string[]) { this.log.push(`reload ${names.join("+")}`); },
  };
  return t satisfies StandbyTarget & Record<string, unknown>;
}

test("Play on while idle: the models unload and new work is held", async () => {
  const t = fake();
  const s = new PlayStandby(t, () => true);
  await s.setPlay("unreal", true);
  assert.deepEqual(t.log, ["hold true", "unload"]);
  assert.equal(s.status()?.state, "paused");
  assert.deepEqual(s.status()?.freed, ["chat model", "ComfyUI"]);
});

test("a turn is running: nothing unloads until it ends, then it unloads", async () => {
  const t = fake(1);
  const s = new PlayStandby(t, () => true);
  await s.setPlay("unity", true);
  assert.deepEqual(t.log, ["hold true"]);
  assert.equal(s.status()?.state, "waiting");
  t.running = 0;
  await s.poke();
  assert.deepEqual(t.log, ["hold true", "hold true", "unload"]);
  assert.equal(s.status()?.state, "paused");
});

test("Play off: the same models load again, then the held work is released", async () => {
  const t = fake();
  const s = new PlayStandby(t, () => true);
  await s.setPlay("unreal", true);
  await s.setPlay("unreal", false);
  assert.deepEqual(t.log.slice(2), ["reload chat model+ComfyUI", "hold false"]);
  assert.equal(s.status(), undefined);
});

test("Play ends while a turn still ran: it only releases, nothing was unloaded to reload", async () => {
  const t = fake(1);
  const s = new PlayStandby(t, () => true);
  await s.setPlay("unreal", true);
  await s.setPlay("unreal", false);
  assert.deepEqual(t.log, ["hold true", "reload ", "hold false"]);
  assert.equal(t.held, false);
});

test("the setting off: nothing happens, and turning it off during Play loads the models back", async () => {
  const t = fake();
  let on = false;
  const s = new PlayStandby(t, () => on);
  await s.setPlay("unreal", true);
  assert.deepEqual(t.log, []);
  on = true;
  await s.poke();
  assert.equal(s.status()?.state, "paused");
  on = false;
  await s.poke();
  assert.equal(t.held, false);
  assert.ok(t.log.includes("reload chat model+ComfyUI"));
});

test("two editors in Play: the card comes back only when the last one leaves", async () => {
  const t = fake();
  const s = new PlayStandby(t, () => true);
  await s.setPlay("unreal", true);
  await s.setPlay("unity", true);
  await s.setPlay("unreal", false);
  assert.equal(t.held, true);
  assert.deepEqual(s.status()?.editors, ["unity"]);
  await s.setPlay("unity", false);
  assert.equal(t.held, false);
});

test("with the real guard: a turn sent while away waits, then runs after the models are back", async () => {
  let loaded = true;
  const calls: string[] = [];
  const item: Unloadable = {
    name: "chat model",
    providers: ["llamacpp"],
    loaded: () => loaded,
    unload: async () => { loaded = false; calls.push("unload"); },
    reload: async () => { loaded = true; calls.push("reload"); },
    pids: () => [],
  };
  const guard = new GpuGuard(() => ({ ...GUARD_DEFAULTS, unloadAfterMinutes: 0 }), async () => "", () => undefined, async () => undefined);
  guard.add(item);
  const s = new PlayStandby(guard, () => true);
  guard.onIdle = () => void s.poke();
  await s.setPlay("unreal", true);
  assert.equal(loaded, false);
  let ran = false;
  const turn = guard.before("llamacpp").then(() => { ran = true; });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(ran, false);
  await s.setPlay("unreal", false);
  await turn;
  assert.equal(loaded, true);
  assert.deepEqual(calls, ["unload", "reload"]);
  guard.after("llamacpp");
});

test("with the real guard: a running turn is never cut, the models unload right after it", async () => {
  let loaded = true;
  const item: Unloadable = { name: "chat model", providers: ["llamacpp"], loaded: () => loaded, unload: async () => { loaded = false; }, reload: async () => { loaded = true; }, pids: () => [] };
  const guard = new GpuGuard(() => ({ ...GUARD_DEFAULTS, unloadAfterMinutes: 0 }), async () => "", () => undefined, async () => undefined);
  guard.add(item);
  const s = new PlayStandby(guard, () => true);
  guard.onIdle = () => void s.poke();
  await guard.before("llamacpp");
  await s.setPlay("unity", true);
  assert.equal(loaded, true);
  guard.after("llamacpp");
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(loaded, false);
});

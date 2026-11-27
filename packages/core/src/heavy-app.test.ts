import { test } from "node:test";
import assert from "node:assert/strict";
import { HeavyAppDetector, LightProfile, LIGHT_DEFAULTS, heavyHits, mergeLightSettings, parseGpuCounters, programKey, type HeavySnapshot, type LightProfileSettings } from "./heavy-app.js";

const none: HeavySnapshot = { games: [] };

test("rules: a game, a full-screen app, a program set to light, a heavy graphics user; allow-list and ignore", () => {
  assert.deepEqual(heavyHits({ games: ["Slay the Spire 2"] }, {}), ["Slay the Spire 2"]);
  assert.deepEqual(heavyHits({ games: [], fullscreen: "Blender" }, {}), ["Blender"]);
  assert.deepEqual(heavyHits({ games: [], fullscreen: "chrome" }, {}), [], "browsers on the allow-list never count");
  assert.deepEqual(heavyHits({ games: [], fullscreen: "blender" }, { blender: "ignore" }), []);
  assert.deepEqual(heavyHits({ games: ["Slay the Spire 2"] }, { "slay the spire 2": "ignore" }), []);
  assert.deepEqual(heavyHits({ games: [], programs: ["Blender.exe", "notepad"] }, { blender: "light" }), ["Blender"]);
  const gpu = (vramMb: number, gpuPct: number, name = "render.exe") => ({ games: [], gpu: [{ name, vramMb, gpuPct }] });
  assert.deepEqual(heavyHits(gpu(600, 40), {}), ["render"]);
  assert.deepEqual(heavyHits(gpu(400, 90), {}), [], "needs more than 500 MB");
  assert.deepEqual(heavyHits(gpu(900, 10), {}), [], "needs more than 30% 3D");
  assert.deepEqual(heavyHits(gpu(9000, 90, "llama-server.exe"), {}), [], "KesherAI's own engines never count");
  assert.deepEqual(heavyHits({ games: ["A"], fullscreen: "a.exe" }, {}), ["A"], "one entry per program");
});

test("hysteresis: heavy after 2 looks in a row, light after 60 s quiet", () => {
  let now = 0;
  const d = new HeavyAppDetector(() => now);
  const game: HeavySnapshot = { games: ["G"] };
  assert.equal(d.feed(game).heavy, false, "one look is not enough");
  assert.equal(d.feed(none).heavy, false);
  assert.equal(d.feed(game).heavy, false, "the streak restarted");
  now += 10_000;
  const on = d.feed(game);
  assert.deepEqual([on.heavy, on.changed, on.apps], [true, "on", ["G"]]);
  assert.equal(d.feed(game).changed, undefined, "no repeat");
  now += 10_000;
  assert.equal(d.feed(none).heavy, true);
  now += 59_000;
  assert.equal(d.feed(none).heavy, true, "59 s quiet is not 60");
  now += 1_000;
  const off = d.feed(none);
  assert.deepEqual([off.heavy, off.changed], [false, "off"]);
  // A blip inside the quiet minute restarts it.
  d.feed(game); d.feed(game);
  now += 50_000; d.feed(none);
  now += 30_000; d.feed(game);
  now += 50_000;
  assert.equal(d.feed(none).heavy, true);
});

test("the controller unloads on heavy, reloads only when asked, and the holds follow the settings", async () => {
  let now = 0;
  const calls: string[] = [];
  let snap: HeavySnapshot = { games: ["G"] };
  let s: LightProfileSettings = { ...LIGHT_DEFAULTS, pauseInbox: true, keepCpuPool: false };
  const lp = new LightProfile({
    settings: () => s,
    now: () => now,
    look: async () => snap,
    actions: { unloadGpu: async () => (calls.push("unload"), ["chat model"]), reloadGpu: async (n) => void calls.push(`reload ${n.join()}`) },
  });
  await lp.tick();
  assert.equal(lp.active(), false);
  assert.deepEqual((await lp.tick()).apps, ["G"]);
  assert.deepEqual(calls, ["unload"]);
  assert.deepEqual(lp.pausesInbox(), ["G"]);
  assert.deepEqual(lp.pausesCpuPool(), ["G"]);
  s = { ...s, pauseInbox: false, keepCpuPool: true };
  assert.deepEqual([lp.pausesInbox(), lp.pausesCpuPool()], [[], []]);
  snap = none;
  await lp.tick();
  now += 61_000;
  const st = await lp.tick();
  assert.equal(st.on, false);
  assert.deepEqual(calls, ["unload"], "nothing reloads by itself");
  // With "reload when done" on.
  s = { ...s, reloadWhenDone: true };
  snap = { games: ["G"] };
  await lp.tick(); await lp.tick();
  snap = none;
  await lp.tick();
  now += 61_000;
  await lp.tick();
  assert.deepEqual(calls, ["unload", "unload", "reload chat model"]);
  // Turned off while heavy: it lets go at once.
  snap = { games: ["G"] };
  await lp.tick(); await lp.tick();
  s = { ...s, enabled: false };
  assert.equal((await lp.tick()).on, false);
  assert.equal(calls.at(-1), "reload chat model");
});

test("settings validation: unknown and badly typed fields are ignored, program names cleaned", () => {
  const m = mergeLightSettings(LIGHT_DEFAULTS, { enabled: "yes", pauseInbox: true, bogus: 1, programs: { "C:\\Games\\Blender.EXE": "light", x: "kill", "": "light", Game: "ignore" } });
  assert.equal(m.enabled, true, "a string is not a boolean");
  assert.equal(m.pauseInbox, true);
  assert.deepEqual(m.programs, { blender: "light", game: "ignore" });
  assert.deepEqual(mergeLightSettings(m, null), m);
  assert.deepEqual(mergeLightSettings(m, { programs: [] }).programs, m.programs, "an array is not a list");
  const many = Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`p${i}`, "light"]));
  assert.equal(Object.keys(mergeLightSettings(LIGHT_DEFAULTS, { programs: many }).programs).length, 200);
  assert.equal(programKey(" /usr/bin/Foo.exe "), "foo");
});

test("GPU counters: memory and 3D engine use are joined by process id", () => {
  const out = parseGpuCounters(
    ["pid_10_luid_0x0_phys_0\t1073741824"],
    ["pid_10_luid_0x0_phys_0_eng_0_engtype_3D\t45.5", "pid_10_luid_0x0_phys_0_eng_1_engtype_VideoDecode\t90", "pid_11_luid_0x0_phys_0_eng_0_engtype_3D\t5"],
    new Map([[10, "game"]]),
  );
  assert.deepEqual(out.find((p) => p.name === "game"), { name: "game", vramMb: 1024, gpuPct: 45.5 });
  assert.equal(out.length, 2);
});

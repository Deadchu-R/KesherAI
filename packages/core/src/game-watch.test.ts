import { test } from "node:test";
import assert from "node:assert/strict";
import { GameWatch } from "./game-watch.js";

test("the game watch names a running game by its install folder and caches the program list", async () => {
  const win = process.platform === "win32";
  const folder = win ? "C:\\Games\\SlayTheSpire2" : "/games/SlayTheSpire2";
  const exe = win ? "C:\\Games\\SlayTheSpire2\\SlayTheSpire2.exe" : "/games/SlayTheSpire2/SlayTheSpire2";
  let now = 1_000_000;
  let reads = 0;
  let running = true;
  const w = new GameWatch({
    now: () => now,
    games: async () => [{ name: "Slay the Spire 2", folder }],
    programs: async () => (reads++, running ? [{ name: "SlayTheSpire2.exe", path: exe }] : []) as never,
  });
  assert.deepEqual(await w.running(), ["Slay the Spire 2"]);
  running = false;
  now += 10_000;
  assert.deepEqual(await w.running(), ["Slay the Spire 2"], "cached for 30 s");
  assert.equal(reads, 1);
  now += 30_001;
  assert.deepEqual(await w.running(), []);
});

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

test("the game watch: callers asking at the same moment share one scan", async () => {
  let scans = 0;
  let reads = 0;
  const w = new GameWatch({ games: async () => (scans++, []), programs: async () => (reads++, []) as never });
  await Promise.all([w.running(), w.running(), w.running()]);
  assert.equal(scans, 1);
  assert.equal(reads, 1);
});

test("callSites names KesherAI's own frames only", async () => {
  const { callSites } = await import("./server/start-engines.js");
  const stack = ["Error", "    at reload (/app/core/dist/server/start-engines.js:51:12)", "    at GpuGuard.before (/app/core/dist/gpu-guard.js:590:9)", "    at Digest.make (/app/core/dist/daily-digest.js:120:5)", "    at async x (node:internal/process/task_queues:95:5)", "    at y (/app/node_modules/fastify/lib/route.js:10:1)", "    at TaskInbox.loop (C:\\KesherAI\\core\\dist\\inbox-runner.js:812:3)"].join("\n");
  assert.equal(callSites(stack), "daily-digest.js:120 < inbox-runner.js:812");
  assert.equal(callSites(undefined), "unknown");
});

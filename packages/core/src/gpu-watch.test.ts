import assert from "node:assert/strict";
import { test } from "node:test";
import { GpuReader, parsePmon } from "./gpu-watch.js";
import { HeavyAppDetector } from "./heavy-app.js";

const PMON = `# gpu         pid   type     sm    mem    enc    dec    jpg    ofa     fb   ccpm    command
# Idx           #    C/G      %      %      %      %      %      %     MB     MB    name
    0       4321     G     62     30      -      -      -      -   2048      0    game.exe
    0       1234   C+G      -      -      -      -      -      -    120      0    dwm.exe
    0       999      C     10      5      -      -      -      -   9000      0    llama-server.exe
`;

test("parsePmon: G and C rows, dashes are 0", () => {
  const rows = parsePmon(PMON);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0], { pid: 4321, type: "G", smPct: 62, fbMb: 2048, command: "game.exe" });
  assert.deepEqual(rows[1], { pid: 1234, type: "C+G", smPct: 0, fbMb: 120, command: "dwm.exe" });
});

test("parsePmon: no processes, junk and empty output", () => {
  assert.deepEqual(parsePmon("# gpu pid type sm mem enc dec command\n# Idx # C/G % % % % name\n"), []);
  assert.deepEqual(parsePmon(""), []);
  assert.deepEqual(parsePmon("NVIDIA-SMI has failed"), []);
});

test("parsePmon: older header without the fb column", () => {
  assert.equal(parsePmon("# gpu pid type sm mem enc dec command\n 0 7 G 5 1 - - a.exe\n")[0]?.fbMb, 0);
});

const smiFrom = (map: Record<string, string | Error>, calls: string[][] = []) => async (args: string[]) => {
  calls.push(args);
  const v = map[args[0] === "pmon" ? "pmon" : args[0]!.includes("compute") ? "compute" : "util"];
  if (v instanceof Error || v === undefined) throw v ?? new Error("none");
  return v;
};

test("reader: pmon rows, own engine ignored, names from the process list", async () => {
  const r = new GpuReader({ smi: smiFrom({ pmon: PMON }), ownPids: () => [999], names: () => new Map([[4321, "TheGame"]]) });
  const out = await r.read();
  assert.deepEqual(out.map((p) => p.name), ["TheGame", "dwm"]);
  assert.equal(out[0]?.vramMb, 2048);
});

test("reader: falls back to the compute list, total use goes to the biggest holder", async () => {
  const r = new GpuReader({ smi: smiFrom({ pmon: new Error("x"), compute: "4321, C:\\Games\\game.exe, 2048\n55, python.exe, 600\n", util: "71\n" }) });
  const out = await r.read();
  assert.deepEqual(out, [{ name: "game", vramMb: 2048, gpuPct: 71 }, { name: "python", vramMb: 600, gpuPct: 0 }]);
});

test("reader: nvidia-smi missing is detected once, no more spawns", async () => {
  const calls: string[][] = [];
  const gone = Object.assign(new Error("spawn"), { code: "ENOENT" });
  let t = 0;
  const r = new GpuReader({ smi: smiFrom({ pmon: gone }, calls), now: () => (t += 20_000) });
  assert.deepEqual(await r.read(), []);
  assert.deepEqual(await r.read(), []);
  assert.equal(calls.length, 1);
});

test("reader: at most one look every 10 s", async () => {
  const calls: string[][] = [];
  let t = 0;
  const r = new GpuReader({ smi: smiFrom({ pmon: PMON }, calls), now: () => t });
  await r.read();
  t = 5000;
  await r.read();
  assert.equal(calls.length, 1);
  t = 10_000;
  await r.read();
  assert.equal(calls.length, 2);
});

test("detector fed by the reader: a busy 3D process makes it heavy after two looks", async () => {
  let t = 0;
  const r = new GpuReader({ smi: smiFrom({ pmon: PMON }), ownPids: () => [999], now: () => t });
  const d = new HeavyAppDetector(() => t);
  let state = d.feed({ games: [], gpu: await r.read() });
  t = 10_000;
  state = d.feed({ games: [], gpu: await r.read() });
  assert.equal(state.heavy, true);
  assert.deepEqual(state.apps, ["game"]);
});

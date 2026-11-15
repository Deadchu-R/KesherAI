import { test } from "node:test";
import assert from "node:assert/strict";
import { closeProgram, memoryPrograms } from "./pc-boost.js";

const MB = 1024 ** 2;

test("memory: programs grouped, biggest first; Windows parts, services and KesherAI never offered", async () => {
  const list = await memoryPrograms([
    { Id: 1, ProcessName: "chrome", WorkingSet64: 400 * MB, MainWindowTitle: "YouTube", SessionId: 1 },
    { Id: 2, ProcessName: "chrome", WorkingSet64: 300 * MB, SessionId: 1 },
    { Id: 3, ProcessName: "Discord", WorkingSet64: 500 * MB, SessionId: 1 },
    { Id: 4, ProcessName: "explorer", WorkingSet64: 900 * MB, SessionId: 1 },
    { Id: 5, ProcessName: "MsMpEng", WorkingSet64: 900 * MB, SessionId: 0 },
    { Id: 6, ProcessName: "KesherAI", WorkingSet64: 900 * MB, SessionId: 1 },
    { Id: 7, ProcessName: "llama-server", WorkingSet64: 9000 * MB, SessionId: 1 },
    { Id: 8, ProcessName: "tiny", WorkingSet64: 10 * MB, SessionId: 1 },
    { Id: 9, ProcessName: "SomeService", WorkingSet64: 800 * MB, SessionId: 0 },
  ]);
  assert.deepEqual(list.map((p) => [p.name, Math.round(p.bytes / MB)]), [["chrome", 700], ["Discord", 500]]);
  assert.equal(list[0]?.title, "YouTube");
});

test("closing: odd names and protected programs are refused", async () => {
  assert.equal((await closeProgram("explorer")).ok, false);
  assert.equal((await closeProgram("a & del x")).ok, false);
});

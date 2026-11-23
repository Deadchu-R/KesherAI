import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LOG_MAX_LINES, LOG_READ_BYTES, findProjectLog, tailProjectLog } from "./unreal-log.js";

/** A project folder with the given files in Saved/Logs. */
async function project(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "kesher-uelog-"));
  await mkdir(join(dir, "Saved", "Logs"), { recursive: true });
  for (const [name, text] of Object.entries(files)) await writeFile(join(dir, "Saved", "Logs", name), text);
  return dir;
}

test("tailProjectLog reads the project's own log: the last lines, filtered by plain text", async () => {
  const dir = await project({
    "Game.log": "\uFEFFLogInit: start\r\nLogPluginManager: Mounting plugin KesherAIBridge\r\nLogKesherAI: Connected to KesherAI.\r\nLogExit: bye\r\n",
    "Game-backup-2026.11.22.log": "old",
  });
  const all = await tailProjectLog(dir, "Game", { lines: 2 });
  assert.equal(all?.file, "Game.log");
  assert.deepEqual(all?.lines, ["LogKesherAI: Connected to KesherAI.", "LogExit: bye"]);
  assert.equal(all?.truncated, false);
  // grep is plain text (a "." or "(" is not a pattern) and case-insensitive.
  const kesher = await tailProjectLog(dir, "Game", { grep: "kesheraibridge" });
  assert.deepEqual(kesher?.lines, ["LogPluginManager: Mounting plugin KesherAIBridge"]);
  assert.deepEqual((await tailProjectLog(dir, "Game", { grep: "(" }))?.lines, []);
});

test("findProjectLog falls back to the newest log; no log gives undefined", async () => {
  const dir = await project({ "Old.log": "a", "Renamed.log": "b" });
  await utimes(join(dir, "Saved", "Logs", "Old.log"), new Date(2020, 0, 1), new Date(2020, 0, 1));
  assert.equal((await findProjectLog(dir, "Game"))?.file, "Renamed.log");
  assert.equal(await tailProjectLog(await mkdtemp(join(tmpdir(), "kesher-uelog-")), "Game"), undefined);
});

test("tailProjectLog reads at most 2 MB from the end and returns at most 2000 lines", async () => {
  const line = "x".repeat(99); // 100 bytes with the line end
  const count = Math.ceil((LOG_READ_BYTES * 1.5) / 100);
  const dir = await project({ "Big.log": Array.from({ length: count }, (_, i) => `${String(i).padStart(8, "0")}${line.slice(8)}`).join("\n") + "\n" });
  const tail = await tailProjectLog(dir, "Big", { lines: 99999 });
  assert.equal(tail?.truncated, true);
  assert.equal(tail?.lines.length, LOG_MAX_LINES);
  assert.ok(tail?.lines.at(-1)?.startsWith(String(count - 1).padStart(8, "0")));
  assert.ok(tail?.lines.every((l) => l.length === 99), "no partial first line");
});

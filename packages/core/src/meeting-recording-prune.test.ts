import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pruneRecordings, recordingDir } from "./meeting-recording.js";

test("kept meeting recordings are deleted after the chosen days; newer ones stay", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kesher-rec-"));
  const now = Date.parse("2026-11-15T12:00:00Z");
  const make = async (id: string, daysOld: number) => {
    const d = recordingDir(dir, id);
    await mkdir(d, { recursive: true });
    await writeFile(join(d, "recording.wav"), "x");
    const at = new Date(now - daysOld * 86_400_000);
    await utimes(join(d, "recording.wav"), at, at);
  };
  await make("old-meeting", 31);
  await make("new-meeting", 5);
  assert.deepEqual(await pruneRecordings(dir, 30, now), ["old-meeting"]);
  assert.equal(await stat(recordingDir(dir, "old-meeting")).catch(() => undefined), undefined);
  assert.ok(await stat(join(recordingDir(dir, "new-meeting"), "recording.wav")));
  assert.deepEqual(await pruneRecordings(dir, 3, now), ["new-meeting"], "a shorter time takes the newer one too");
  assert.deepEqual(await pruneRecordings(join(dir, "none"), 30, now), [], "no recordings folder: nothing to do");
});

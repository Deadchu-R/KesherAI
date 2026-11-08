import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRecording, encodeWav, keepRecordingPiece, recordingResponse } from "./meeting-recording.js";
import { wavSamples } from "./meeting-speakers.js";

test("kept pieces become one recording on the meeting's timeline", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kesher-rec-"));
  const tone = (n: number, v: number) => new Float32Array(n).fill(v);
  // The microphone at 0 s for 1 s, the call at 0.5 s for 1 s (they overlap and mix), and later the microphone at 3 s.
  await keepRecordingPiece(dir, 1_000_000, "me", encodeWav(tone(16_000, 0.25)));
  await keepRecordingPiece(dir, 1_000_500, "others", encodeWav(tone(16_000, 0.25)));
  await keepRecordingPiece(dir, 1_003_000, "me", encodeWav(tone(8_000, 0.1)));
  const r = await buildRecording(dir);
  assert.deepEqual(r, { start: 1_000_000, seconds: 3.5 });
  assert.equal(existsSync(join(dir, "pieces")), false);
  const all = wavSamples(await readFile(join(dir, "recording.wav")));
  assert.equal(all.length, 56_000);
  assert.ok(Math.abs(all[100]! - 0.25) < 0.001);
  assert.ok(Math.abs(all[12_000]! - 0.5) < 0.001, "overlap mixes");
  assert.equal(all[30_000], 0, "silence between");
  assert.ok(Math.abs(all[50_000]! - 0.1) < 0.001);
  const part = await recordingResponse(dir, "bytes=0-99");
  assert.equal(part?.status, 206);
  assert.equal(part?.headers["content-range"], `bytes 0-99/${44 + 56_000 * 2}`);
  assert.equal(await buildRecording(await mkdtemp(join(tmpdir(), "kesher-rec-"))), undefined);
});

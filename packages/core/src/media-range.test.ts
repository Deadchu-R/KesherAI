import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkRange, extractRange, frameArgs, frameTimes, mediaRangeTools, rangeAudioArgs } from "./media-range.js";

/** A fake FFmpeg: writes the file named last, and remembers every call. */
function fake() {
  const calls: string[][] = [];
  return { calls, run: async (args: string[]) => { calls.push(args); await writeFile(args.at(-1)!, `bytes:${args.at(-1)!.split(/[\\/]/).pop()}`); } };
}

test("checkRange: numbers, order and length are checked", () => {
  assert.deepEqual(checkRange(1.23456, "5"), { start: 1.235, end: 5 });
  assert.throws(() => checkRange(-1, 4));
  assert.throws(() => checkRange(4, 4.05));
  assert.throws(() => checkRange("a", 4));
  assert.throws(() => checkRange(0, 99999));
});

test("frameTimes: the middles of equal parts, at most 8", () => {
  assert.deepEqual(frameTimes({ start: 10, end: 20 }, 1), [15]);
  assert.deepEqual(frameTimes({ start: 0, end: 8 }, 4), [1, 3, 5, 7]);
  assert.equal(frameTimes({ start: 0, end: 80 }, 50).length, 8);
});

test("the FFmpeg arguments seek before the input and end in the output", () => {
  const f = frameArgs("a.mp4", 3.5, "o.jpg");
  assert.ok(f.indexOf("-ss") < f.indexOf("-i") && f.at(-1) === "o.jpg");
  const a = rangeAudioArgs("a.mp3", { start: 2, end: 6.5 }, "o.wav");
  assert.deepEqual(a.slice(a.indexOf("-ss"), a.indexOf("-ss") + 4), ["-ss", "2", "-t", "4.5"]);
  assert.ok(a.includes("pcm_s16le") && a.at(-1) === "o.wav");
});

test("extractRange: frames are read back and the temporary folder is removed; the sound goes to its folder", async () => {
  const root = await mkdtemp(join(tmpdir(), "kesher-range-"));
  try {
    const r = fake();
    const out = await extractRange(r, "clip.mp4", join(root, ".ranges"), { start: 0, end: 8 }, { frames: 3, audio: true, tag: "clip-0-8" }, join(root, "tmp"));
    assert.equal(out.frames.length, 3);
    assert.match(out.frames[0]!.data.toString(), /^bytes:frame-0\.jpg/);
    assert.equal(r.calls.length, 4);
    assert.equal(await readFile(out.audio!, "utf8"), "bytes:clip-0-8.wav");
    assert.deepEqual((await readdir(root)).sort(), [".ranges"]);
    await assert.rejects(extractRange(r, "x.mp3", root, { start: 0, end: 700 }, { frames: 0, audio: true, tag: "t" }, join(root, "t")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("media_range: read-only tool; a video gives frames, a sound gives a WAV and no frames", async () => {
  const ws = await mkdtemp(join(tmpdir(), "kesher-rangews-"));
  try {
    await writeFile(join(ws, "a.mp4"), "v");
    await writeFile(join(ws, "b.mp3"), "s");
    const r = fake();
    const [tool] = mediaRangeTools({ runner: async () => r });
    assert.equal(tool!.risk, "read");
    const ctx = { workspace: ws, signal: new AbortController().signal, recordChange: () => undefined };
    const v = await tool!.run({ path: "a.mp4", start: 2, end: 10, frames: 2 }, ctx);
    assert.equal(v.images?.length, 2);
    assert.equal(v.images?.[0]?.mimeType, "image/jpeg");
    assert.match(v.output, /0:02 to 0:10/);
    const s = await tool!.run({ path: "b.mp3", start: 1, end: 5 }, ctx);
    assert.equal(s.images, undefined);
    assert.match(s.output, /\.ranges\/b-1-5\.wav/);
    await assert.rejects(tool!.run({ path: "../x.mp4", start: 0, end: 2 }, ctx));
    await assert.rejects(tool!.run({ path: "a.mp4", start: 5, end: 2 }, ctx));
  } finally {
    await rm(ws, { recursive: true, force: true });
  }
});

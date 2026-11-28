import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { audioProxyArgs, durationOf, isPrepId, mediaKey, parseByteRange, PeaksBuilder, prepare, proxyArgs, spriteArgs, spriteLayout, type PrepRunner } from "./media-prep.js";

const VIDEO = "Duration: 00:00:03.50, start: 0.000000, bitrate: 1000 kb/s\n  Stream #0:0: Video: h264, yuv420p, 1920x1080, 25 fps, 25 tbr\n  Stream #0:1: Audio: aac, 44100 Hz, stereo";
const SOUND = "Duration: 01:00:00.00, start: 0\n  Stream #0:0: Audio: mp3, 44100 Hz, stereo";

/** 16-bit little-endian PCM of a sine, as FFmpeg would print it. */
function sine(samples: number, amp: number, period: number): Buffer {
  const b = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) b.writeInt16LE(Math.round(amp * Math.sin((2 * Math.PI * i) / period)), i * 2);
  return b;
}

test("peaks of a sine: min/max pairs per 256 samples, in any chunking", () => {
  const pcm = sine(1024, 16384, 64);
  const whole = new PeaksBuilder();
  whole.push(pcm);
  const a = whole.finish();
  assert.equal(a.length, 8);
  for (let c = 0; c < 4; c++) {
    assert.ok(a[c * 2]! <= 128 - 63 && a[c * 2]! >= 128 - 65, `min ${a[c * 2]}`);
    assert.ok(a[c * 2 + 1]! >= 128 + 63 && a[c * 2 + 1]! <= 128 + 64, `max ${a[c * 2 + 1]}`);
  }
  // Odd-sized pieces (a sample split between two) give the same result.
  const split = new PeaksBuilder();
  for (let i = 0; i < pcm.length; i += 7) split.push(pcm.subarray(i, i + 7));
  assert.deepEqual(split.finish(), a);
  // Silence is 128,128; a short last column is kept.
  const quiet = new PeaksBuilder();
  quiet.push(Buffer.alloc(600));
  assert.deepEqual([...quiet.finish()], [128, 128, 128, 128]);
});

test("FFmpeg arguments: proxy key frames by frame rate, sprite grid, audio proxy", () => {
  const p = proxyArgs("in.mp4", "o.mp4", 30);
  assert.equal(p[p.indexOf("-g") + 1], "15");
  assert.equal(proxyArgs("in.mp4", "o.mp4", 60)[proxyArgs("in.mp4", "o.mp4", 60).indexOf("-g") + 1], "30");
  assert.ok(p.includes("libx264") && p.join(" ").includes("min(480\\,ih)"));
  assert.deepEqual(spriteLayout(3.5), { cols: 20, rows: 1, w: 160, h: 90, every: 1, count: 4 });
  assert.equal(spriteLayout(7200).every, 3);
  assert.match(spriteArgs("in.mp4", "s.jpg", spriteLayout(100)).join(" "), /fps=1\/1,scale=160:90.*tile=20x5/);
  assert.ok(audioProxyArgs("a.mp3", "o.m4a").includes("-vn"));
  assert.equal(durationOf(VIDEO), 3.5);
  assert.equal(durationOf(SOUND), 3600);
});

test("byte ranges", () => {
  assert.equal(parseByteRange(undefined, 100), undefined);
  assert.deepEqual(parseByteRange("bytes=10-19", 100), { start: 10, end: 19 });
  assert.deepEqual(parseByteRange("bytes=90-", 100), { start: 90, end: 99 });
  assert.deepEqual(parseByteRange("bytes=-10", 100), { start: 90, end: 99 });
  assert.deepEqual(parseByteRange("bytes=50-500", 100), { start: 50, end: 99 });
  assert.equal(parseByteRange("bytes=100-", 100), "bad");
  assert.equal(parseByteRange("bytes=9-3", 100), "bad");
});

test("prepare with a fake FFmpeg: video gets proxy, sprite and peaks; sound gets proxy and peaks; nothing half-made stays", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kesher-prep-"));
  try {
    const calls: string[][] = [];
    const fake = (text: string): PrepRunner => ({
      probe: async () => text,
      run: async (args) => {
        calls.push(args);
        await writeFile(args.at(-1)!, "x");
      },
      stream: async (_args, onData) => onData(sine(1024, 8000, 32)),
    });
    const steps: string[] = [];
    const v = await prepare(fake(VIDEO), "in.mp4", join(dir, "v"), "a".repeat(40), (s) => steps.push(s.step ?? ""));
    assert.deepEqual(steps, ["proxy", "sprite", "peaks"]);
    // The sprite is cut from the proxy just made (480 p), not decoded again from the original.
    const spriteCall = calls.find((c) => c.at(-1)!.endsWith(".tmp-sprite.jpg"))!;
    assert.equal(spriteCall[spriteCall.indexOf("-i") + 1], join(dir, "v", "proxy.mp4"));
    assert.equal(v.kind, "video");
    assert.deepEqual(v.sprite, spriteLayout(3.5));
    assert.deepEqual(v.peaks, { rate: 8000, perColumn: 256, columns: 4 });
    assert.equal((await readFile(join(dir, "v", "peaks.bin"))).length, 8);
    assert.deepEqual(JSON.parse(await readFile(join(dir, "v", "sprite.json"), "utf8")), spriteLayout(3.5));
    assert.ok((await stat(join(dir, "v", "proxy.mp4"))).isFile());
    assert.equal(calls.length, 2);
    const a = await prepare(fake(SOUND), "in.mp3", join(dir, "a"), "b".repeat(40));
    assert.equal(a.kind, "audio");
    assert.equal(a.ready.sprite, false);
    assert.ok((await stat(join(dir, "a", "proxy.m4a"))).isFile());
    await assert.rejects(prepare(fake("nothing"), "x", join(dir, "n"), "c".repeat(40)), /no picture or sound/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the key follows the content and the modified time; an id is only hex", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kesher-key-"));
  try {
    const f = join(dir, "a.bin");
    await writeFile(f, "hello");
    const k1 = await mediaKey(f);
    assert.equal(await mediaKey(f), k1);
    await writeFile(f, "hellp");
    assert.notEqual(await mediaKey(f), k1);
    assert.ok(isPrepId(k1));
    for (const bad of ["../x", "a".repeat(39), "A".repeat(40), `${"a".repeat(40)}/..`]) assert.equal(isPrepId(bad), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

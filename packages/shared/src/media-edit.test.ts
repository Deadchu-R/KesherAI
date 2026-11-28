import { test } from "node:test";
import assert from "node:assert/strict";
import { checkMediaEdit, mediaEditToFfmpeg, MAX_LANES, type MediaEdit } from "./media-edit.js";

const base = (over: Partial<MediaEdit> = {}): MediaEdit => ({ v: 1, video: [{ src: 0, from: 0, to: 2 }], lanes: [], ...over });

test("a media edit is checked, rounded, and its defaults left out", () => {
  const e = checkMediaEdit({ v: 1, video: [{ src: 0, from: 0.0004, to: 2.00049, speed: 1, volume: 1.5 }], lanes: [{ src: 1, start: 1, ops: [{ op: "gain", a: 0, b: 1, db: -3.04 }] }] }, 2);
  assert.deepEqual(e.video, [{ src: 0, from: 0, to: 2, volume: 1.5 }]);
  assert.deepEqual(e.lanes[0], { src: 1, start: 1, ops: [{ op: "gain", a: 0, b: 1, db: -3 }] });
});

test("a bad media edit is refused", () => {
  assert.throws(() => checkMediaEdit(null, 1), /not a media edit/);
  assert.throws(() => checkMediaEdit({ v: 1, video: [], lanes: [] }, 1), /empty/);
  assert.throws(() => checkMediaEdit({ v: 1, video: [{ src: 1, from: 0, to: 1 }], lanes: [] }, 1), /not sent/);
  assert.throws(() => checkMediaEdit({ v: 1, video: [{ src: 0, from: "0; rm", to: 1 }], lanes: [] }, 1), /start and an end/);
  assert.throws(() => checkMediaEdit({ v: 1, video: [{ src: 0, from: 0, to: 1, speed: 9 }], lanes: [] }, 1), /speed/);
  const lane = { src: 0, start: 0, ops: [] };
  assert.throws(() => checkMediaEdit({ v: 1, video: [], lanes: Array(MAX_LANES + 1).fill(lane) }, 1), /At most 4/);
  assert.throws(() => checkMediaEdit({ v: 1, video: [], lanes: [{ ...lane, ops: [{ op: "reverse", a: 0, b: 1 }] }] }, 1), /Unknown/);
  assert.throws(() => checkMediaEdit({ v: 1, video: [], lanes: [{ ...lane, ops: [{ op: "fade", a: 0, b: 1, dir: "up" }] }] }, 1), /in or out/);
  assert.throws(() => checkMediaEdit({ v: 1, video: [], lanes: [{ ...lane, ops: [{ op: "gain", a: 0, b: 1, db: 99 }] }] }, 1), /dB/);
  assert.throws(() => checkMediaEdit({ v: 1, video: [], lanes: [{ ...lane, ops: [{ op: "silence", at: 1, duration: 0 }] }] }, 1), /Silence/);
});

test("one clip: trimmed, with its sound", () => {
  const g = mediaEditToFfmpeg(base({ video: [{ src: 0, from: 1, to: 3, speed: 2 }] }), [{ file: "a.mp4" }]);
  assert.deepEqual(g.inputs, ["a.mp4"]);
  assert.match(g.filter, /\[0:v\]trim=start=1:end=3,setpts=\(PTS-STARTPTS\)\/2\[v0\]/);
  assert.match(g.filter, /atempo=2\[a0\]/);
  assert.equal(g.video, "[vout]");
  assert.equal(g.audio, "[aout]");
  assert.equal(g.duration, 1);
});

test("two clips join plainly, or with a transition that shortens the whole", () => {
  const two = [{ src: 0, from: 0, to: 4 }, { src: 0, from: 10, to: 14 }];
  const plain = mediaEditToFfmpeg(base({ video: two }), [{ file: "a.mp4" }]);
  assert.match(plain.filter, /\[v0\]\[a0\]\[v1\]\[a1\]concat=n=2:v=1:a=1\[vout\]\[aout\]/);
  assert.equal(plain.duration, 8);
  const fade = mediaEditToFfmpeg(base({ video: [two[0]!, { ...two[1]!, into: { kind: "fade", seconds: 1 } }] }), [{ file: "a.mp4" }]);
  assert.match(fade.filter, /xfade=transition=fade:duration=1:offset=3\[vout\]/);
  assert.match(fade.filter, /acrossfade=d=1\[aout\]/);
  assert.equal(fade.duration, 7);
});

test("a clip with no sound gets silence, and a frame fits every clip", () => {
  const g = mediaEditToFfmpeg(base({ frame: { w: 1280, h: 720, fps: 30 } }), [{ file: "a.png", audio: false }]);
  assert.match(g.filter, /anullsrc=r=44100:cl=stereo,atrim=duration=2\[a0\]/);
  assert.match(g.filter, /scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:.*fps=30/);
});

test("sound operations run in order on a lane, which is delayed and mixed over the video", () => {
  const e = checkMediaEdit({
    v: 1, video: [{ src: 0, from: 0, to: 10 }],
    lanes: [{ src: 1, start: 2.5, volume: 0.5, ops: [{ op: "trim", a: 1, b: 9 }, { op: "fade", a: 0, b: 2, dir: "in" }, { op: "cut", a: 3, b: 4 }, { op: "silence", at: 5, duration: 1 }, { op: "gain", a: 0, b: 2, db: -6 }] }],
  }, 2);
  const g = mediaEditToFfmpeg(e, [{ file: "v.mp4" }, { file: "m.mp3" }]);
  const f = g.filter;
  assert.ok(f.indexOf("atrim=start=1:end=9") < f.indexOf("afade=t=in:st=0:d=2"));
  assert.ok(f.indexOf("afade=t=in") < f.indexOf("asplit"));
  assert.match(f, /atrim=end=3,asetpts=PTS-STARTPTS\[l0_\d+\];\[l0_\d+\]atrim=start=4/);
  assert.match(f, /concat=n=3:v=0:a=1/);
  assert.match(f, /anullsrc=r=44100:cl=stereo,atrim=duration=1\[/);
  assert.match(f, /volume=-6dB:enable='between\(t,0,2\)'/);
  assert.match(f, /adelay=2500\|2500,volume=0.5\[l0_o\]/);
  assert.match(f, /\[aout\]\[l0_o\]amix=inputs=2:duration=longest:normalize=0\[mixed\]/);
  assert.equal(g.audio, "[mixed]");
});

test("a sound-only edit has no picture, and a lane on a silent file is refused", () => {
  const e = checkMediaEdit({ v: 1, video: [], lanes: [{ src: 0, start: 0, ops: [] }] }, 1);
  const g = mediaEditToFfmpeg(e, [{ file: "s.wav" }]);
  assert.equal(g.video, undefined);
  assert.equal(g.audio, "[l0_o]");
  assert.throws(() => mediaEditToFfmpeg(e, [{ file: "x.png", audio: false }]), /with sound/);
});

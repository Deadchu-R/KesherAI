import { test } from "node:test";
import assert from "node:assert/strict";
import { checkSegments, cutArgs } from "./video-cut.js";

test("the stretches to keep are checked and rounded", () => {
  assert.deepEqual(checkSegments([{ from: 0, to: 2.00049 }, { from: 5, to: 9 }]), [{ from: 0, to: 2 }, { from: 5, to: 9 }]);
  assert.throws(() => checkSegments([]), /1 to/);
  assert.throws(() => checkSegments([{ from: 3, to: 3.05 }]), /0.1 s/);
  assert.throws(() => checkSegments([{ from: -1, to: 2 }]), /start and an end/);
  assert.throws(() => checkSegments([{ from: "0; rm", to: 2 }]), /start and an end/);
});

test("FFmpeg keeps the stretches in order and joins them, with or without sound", () => {
  const a = cutArgs("in.mp4", "out.mp4", [{ from: 1, to: 2 }, { from: 4, to: 5.5 }], true);
  const g = a[a.indexOf("-filter_complex") + 1]!;
  assert.match(g, /\[0:v\]trim=start=1:end=2,setpts=PTS-STARTPTS\[v0\]/);
  assert.match(g, /\[v0\]\[a0\]\[v1\]\[a1\]concat=n=2:v=1:a=1\[v\]\[a\]$/);
  assert.equal(a.at(-1), "out.mp4");
  const b = cutArgs("in.mp4", "out.mp4", [{ from: 0, to: 1 }], false);
  assert.ok(!b.join(" ").includes("[0:a]"));
  assert.ok(!b.includes("aac"));
});

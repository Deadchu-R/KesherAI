import { test } from "node:test";
import assert from "node:assert/strict";
import { checkMediaEdit } from "@kesher/shared";
import { clipAt, dropIndex, editLen, estimateBytes, fitPps, history, locate, moveClip, push, redo, removeClip, setClip, setTransition, sizeText, snap, snapPoints, splitAt, starts, tickStep, timeToX, trimEnd, undo, wholeFile, xToTime, zoomBy } from "./media-timeline";

const three = () => {
  let e = wholeFile(30);
  e = splitAt(e, 10)!.edit;
  e = splitAt(e, 20)!.edit;
  return e;
};

test("time and x map both ways, the playhead in the middle", () => {
  const v = { pps: 20, width: 390 };
  assert.equal(timeToX(v, 5, 5), 195);
  assert.equal(timeToX(v, 5, 6), 215);
  assert.equal(xToTime(v, 5, timeToX(v, 5, 7.25)), 7.25);
  assert.equal(fitPps(10, 390), 31.2);
  assert.equal(zoomBy(10, 1000), 400);
  assert.equal(zoomBy(10, 0.0001), 0.5);
  assert.equal(tickStep(60), 1);
  assert.ok(tickStep(1) >= 60);
});

test("split cuts the clip under the playhead and keeps the source times", () => {
  const e = three();
  assert.deepEqual(e.video.map((c) => [c.from, c.to]), [[0, 10], [10, 20], [20, 30]]);
  assert.equal(splitAt(e, 10.05), undefined, "a piece shorter than 0.1 s is refused");
  assert.equal(splitAt(e, 0), undefined);
  assert.deepEqual(starts(e), [0, 10, 20]);
  assert.equal(editLen(e), 30);
  assert.equal(clipAt(e, 25), 2);
  assert.equal(clipAt(e, 30), 2);
  checkMediaEdit(e, 1);
});

test("split of a sped-up clip maps the timeline time to the source", () => {
  let e = setClip(wholeFile(20), 0, { speed: 2 }); // 10 s on the timeline
  e = splitAt(e, 4)!.edit;
  assert.deepEqual(e.video.map((c) => [c.from, c.to, c.speed]), [[0, 8, 2], [8, 20, 2]]);
  assert.deepEqual(locate(e, 5), { index: 1, src: 0, time: 10 });
});

test("trim moves one end, stays in the file and keeps 0.1 s", () => {
  const e = three();
  assert.equal(trimEnd(e, 1, "start", 12).video[1]!.from, 12);
  assert.equal(trimEnd(e, 1, "end", 18).video[1]!.to, 18);
  assert.equal(trimEnd(e, 1, "end", 1000, 30).video[1]!.to, 30);
  assert.equal(trimEnd(e, 1, "start", 99).video[1]!.from, 19.9);
  assert.equal(trimEnd(e, 1, "start", -5).video[1]!.from, 0);
  assert.equal(e.video[1]!.from, 10, "the original is untouched");
});

test("remove, move and drop target", () => {
  const e = three();
  assert.deepEqual(removeClip(e, 1)!.video.map((c) => c.from), [0, 20]);
  assert.equal(removeClip(wholeFile(5), 0), undefined);
  assert.deepEqual(moveClip(e, 0, 2).video.map((c) => c.from), [10, 20, 0]);
  assert.equal(moveClip(e, 0, 9), e);
  assert.equal(dropIndex(e, 0, 12), 1);
  assert.equal(dropIndex(e, 0, 1), 0);
  assert.equal(dropIndex(e, 0, 29), 2);
});

test("speed, volume and fade keep the edit valid and leave defaults out", () => {
  let e = setClip(three(), 1, { speed: 9, volume: 0.5 });
  assert.equal(e.video[1]!.speed, 4);
  assert.equal(e.video[1]!.volume, 0.5);
  e = setClip(e, 1, { speed: 1, volume: 1 });
  assert.ok(!("speed" in e.video[1]!) && !("volume" in e.video[1]!));
  e = setTransition(e, 1, 0.8);
  assert.deepEqual(e.video[1]!.into, { kind: "fade", seconds: 0.8 });
  assert.equal(setTransition(e, 0, 1), e);
  assert.ok(!("into" in setTransition(e, 1, 0).video[1]!));
  checkMediaEdit(e, 1);
});

test("snap jumps to a near edge and the playhead, not to a far one", () => {
  const e = three();
  const pts = snapPoints(e, 14);
  assert.deepEqual(snap(10.2, pts, 20), { t: 10, hit: 10 });
  assert.deepEqual(snap(12, pts, 20), { t: 12 });
  assert.deepEqual(snap(14.3, pts, 20), { t: 14, hit: 14 });
});

test("history: undo, redo, a new step drops the redo steps, equal steps are not kept", () => {
  let h = history(1);
  h = push(h, 2);
  h = push(h, 2);
  h = push(h, 3);
  assert.deepEqual(h.past, [1, 2]);
  h = undo(undo(h));
  assert.equal(h.now, 1);
  assert.equal(undo(h), h);
  h = redo(h);
  assert.equal(h.now, 2);
  h = push(h, 9);
  assert.deepEqual(h.future, []);
  assert.equal(redo(h), h);
});

test("export size estimate grows with size, quality, fps and length", () => {
  const base = estimateBytes(60, { height: 720, fps: 30, quality: "medium" });
  assert.ok(base > 15e6 && base < 25e6, String(base));
  assert.ok(estimateBytes(60, { height: 1080, fps: 30, quality: "medium" }) > base);
  assert.ok(estimateBytes(60, { height: 720, fps: 60, quality: "medium" }) > base);
  assert.ok(estimateBytes(60, { height: 720, fps: 30, quality: "low" }) < base);
  assert.equal(estimateBytes(0, { height: 720, fps: 30, quality: "high" }), 0);
  assert.equal(sizeText(18_500_000), "19 MB");
  assert.equal(sizeText(1_400_000_000), "1.4 GB");
});

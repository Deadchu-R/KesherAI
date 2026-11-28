import { test } from "node:test";
import assert from "node:assert/strict";
import { checkMediaEdit, mediaEditToFfmpeg } from "@kesher/shared";
import { checkLook, exportArgs, progressOf } from "./media-export.js";

test("checkLook keeps only the offered values", () => {
  assert.deepEqual(checkLook({ height: 1080, fps: 60, quality: "high" }), { height: 1080, fps: 60, quality: "high" });
  assert.deepEqual(checkLook({ height: 99999, fps: "x", quality: "ultra" }), { height: 720, fps: 30, quality: "medium" });
  assert.deepEqual(checkLook(undefined), { height: 720, fps: 30, quality: "medium" });
});

test("exportArgs: picture is fitted, never enlarged; a sound-only edit is an m4a", () => {
  const e = checkMediaEdit({ v: 1, video: [{ src: 0, from: 0, to: 4 }], lanes: [] }, 1);
  const g = mediaEditToFfmpeg(e, [{ file: "/a/in.mp4" }]);
  const a = exportArgs(g, "/a/out.mp4", { height: 720, fps: 30, quality: "high" });
  assert.deepEqual(a.slice(a.indexOf("-i"), a.indexOf("-i") + 2), ["-i", "/a/in.mp4"]);
  const fc = a[a.indexOf("-filter_complex") + 1]!;
  assert.match(fc, /\[vout\]scale=-2:'min\(720,ih\)',fps=30,format=yuv420p\[vfinal\]$/);
  assert.equal(a[a.indexOf("-crf") + 1], "20");
  assert.equal(a.at(-1), "/a/out.mp4");
  const s = checkMediaEdit({ v: 1, video: [], lanes: [{ src: 0, start: 0, ops: [{ op: "trim", a: 1, b: 3 }] }] }, 1);
  const sa = exportArgs(mediaEditToFfmpeg(s, [{ file: "/a/in.mp3" }]), "/a/out.m4a", checkLook({}));
  assert.ok(sa.includes("-vn") && !sa.includes("libx264"));
});

test("progressOf reads the last out_time and clamps", () => {
  assert.equal(progressOf("frame=1\nout_time_ms=1000000\nout_time_ms=2500000\nprogress=continue\n", 10), 0.25);
  assert.equal(progressOf("out_time_ms=99000000", 10), 1);
  assert.equal(progressOf("frame=3\n", 10), undefined);
  assert.equal(progressOf("out_time_ms=1000000", 0), undefined);
});

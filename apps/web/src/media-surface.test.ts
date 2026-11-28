import { test } from "node:test";
import assert from "node:assert/strict";
import { BUILT_IN, buildSurfaces, itemFromResult, openTarget } from "./surfaces.js";
import { clockText, fraction, markRange, rangeAsk, rangeMessage, spriteCell, waveColumns } from "./media-surface.js";

const list = buildSurfaces(BUILT_IN, { parts: [], pluginPages: [] });

test("video and sound are registered without a part, ahead of the editors, and open their file types", () => {
  assert.deepEqual(list.map((s) => s.id).slice(-2), ["video", "sound"]);
  for (const f of ["a.mp4", "A.MOV", "x.webm", "y.mkv"]) assert.equal(openTarget(BUILT_IN, list, f)?.surface.id, "video", f);
  for (const f of ["a.mp3", "b.WAV", "c.ogg", "d.flac", "e.m4a"]) assert.equal(openTarget(BUILT_IN, list, f)?.surface.id, "sound", f);
  assert.equal(openTarget(BUILT_IN, list, "notes.txt"), undefined);
  const video = BUILT_IN.find((s) => s.id === "video")!;
  assert.equal(video.phone, "view+ask");
  assert.ok(typeof video.card === "function" && typeof video.panel === "function" && video.tools.includes("media_range"));
});

test("fromResult: the made video or sound's asset id, only from its own tools and only when it worked", () => {
  assert.deepEqual(itemFromResult(list, "generate_video", true, "Generated a video", { videoIds: ["v1"] }), { surface: "video", kind: "video", id: "v1" });
  assert.deepEqual(itemFromResult(list, "animate_picture", true, "", { videoIds: ["v2"] })?.id, "v2");
  assert.deepEqual(itemFromResult(list, "make_music", true, "Made the song", { audioIds: ["a1", "a2"] }), { surface: "sound", kind: "audio", id: "a1" });
  assert.equal(itemFromResult(list, "make_sound", true, "", { audioIds: ["s1"] })?.surface, "sound");
  assert.equal(itemFromResult(list, "speak_text", true, "", { audioIds: ["s2"] })?.id, "s2");
  assert.equal(itemFromResult(list, "make_music", false, "", { audioIds: ["a1"] }), undefined);
  assert.equal(itemFromResult(list, "make_music", true, "no ids"), undefined);
  assert.equal(itemFromResult(list, "generate_video", true, "", { audioIds: ["a1"] }), undefined);
  assert.equal(itemFromResult(list, "make_music", true, "", { videoIds: ["v1"] }), undefined);
});

test("waveColumns: peaks (min,max byte pairs; 128 is silence) become min/max per drawn column", () => {
  // Four source columns: silence, a loud one, a quiet one, silence.
  const peaks = Uint8Array.from([128, 128, 0, 255, 100, 150, 128, 128]);
  const four = waveColumns(peaks, 4);
  assert.equal(four.length, 4);
  assert.deepEqual(four[0], [0, 0]);
  assert.deepEqual(four[1], [-1, 127 / 128]);
  // Squeezed to two columns each takes the extremes of its pair of source columns.
  const two = waveColumns(peaks, 2);
  assert.deepEqual(two[0], [-1, 127 / 128]);
  assert.deepEqual(two[1], [(100 - 128) / 128, (150 - 128) / 128]);
  // More drawn columns than source ones: every column still gets a value.
  assert.equal(waveColumns(peaks, 10).length, 10);
  assert.deepEqual(waveColumns(new Uint8Array(), 5), []);
  assert.deepEqual(waveColumns(peaks, 0), []);
});

test("clockText, fraction and markRange", () => {
  assert.equal(clockText(65.4), "1:05");
  assert.equal(clockText(3725), "1:02:05");
  assert.equal(clockText(-3), "0:00");
  assert.equal(fraction(5, 20), 0.25);
  assert.equal(fraction(5, 0), 0);
  assert.deepEqual(markRange(12.345, 4, 30), { start: 4, end: 12.35 });
  assert.deepEqual(markRange(-5, 99, 30), { start: 0, end: 30 });
  assert.equal(markRange(5, 5.05, 30), undefined);
});

test("spriteCell: one thumbnail per `every` seconds, row by row, clamped to the last", () => {
  const s = { cols: 20, rows: 3, w: 160, h: 90, every: 2, count: 45 };
  assert.deepEqual(spriteCell(s, 0), { col: 0, row: 0 });
  assert.deepEqual(spriteCell(s, 41), { col: 0, row: 1 });
  assert.deepEqual(spriteCell(s, 9999), { col: 4, row: 2 });
});

test("range → ask payload and chat message, in both languages", () => {
  const file = { surface: "video", kind: "video", id: "clips/a.mp4", path: "clips/a.mp4", convId: "c1" };
  assert.deepEqual(rangeAsk(file, { start: 12.5, end: 20 }), { file: "clips/a.mp4", by: "path", start: 12.5, end: 20 });
  const made = { surface: "sound", kind: "audio", id: "0b8d6a40-0000-4000-8000-000000000000" };
  assert.deepEqual(rangeAsk(made, { start: 1, end: 3 }), { file: made.id, by: "asset", start: 1, end: 3 });
  const en = rangeMessage(rangeAsk(file, { start: 12.5, end: 65 }), "a.mp4", "who speaks?", false);
  assert.match(en, /^About 0:13-1:05 of "a\.mp4": who speaks\?/);
  assert.match(en, /\[media_range path="clips\/a\.mp4" start=12\.5 end=65\]$/);
  const he = rangeMessage(rangeAsk(file, { start: 1, end: 4 }), "a.mp4", "  ", true);
  assert.match(he, /^על הקטע 0:01-0:04 של "a\.mp4": מה קורה בקטע הזה\?/);
});

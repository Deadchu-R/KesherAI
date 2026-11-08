import { test } from "node:test";
import assert from "node:assert/strict";
import { assignSpeakers, wavSamples } from "./meeting-speakers.js";
import { speechParts, wavFrom } from "./whisper.js";

test("whisper's timed output becomes pieces with seconds", () => {
  const out = "[00:00:00.000 --> 00:00:02.500]   Hello there.\n[00:00:02.500 --> 00:01:03.000]  How are you?\n[00:01:03.000 --> 00:01:04.000]   [BLANK_AUDIO]\n";
  assert.deepEqual(speechParts(out), [
    { start: 0, end: 2.5, text: "Hello there." },
    { start: 2.5, end: 63, text: "How are you?" },
  ]);
});

test("WAV bytes round-trip to samples", () => {
  const s = wavSamples(wavFrom(new Float32Array([0, 0.5, -0.5, 1])));
  assert.equal(s.length, 4);
  assert.ok(Math.abs(s[1]! - 0.5) < 0.001 && Math.abs(s[2]! + 0.5) < 0.001);
});

test("speakers: each whisper piece goes to who talked most, neighbours join, numbered by first appearance", () => {
  const t0 = 1_000_000;
  const segments = [
    { t: t0, text: "a b c", who: "others" as const, parts: [{ start: 0, end: 4, text: "Hi all." }, { start: 4, end: 9, text: "Me too." }, { start: 9, end: 12, text: "Agreed." }] },
    { t: t0 + 30_000, text: "Bye.", who: "others" as const },
  ];
  const pieces = [{ t: t0, offset: 0, duration: 30 }, { t: t0 + 30_000, offset: 30, duration: 10 }];
  const turns = [{ start: 0, end: 4.2, speaker: 5 }, { start: 4.2, end: 9, speaker: 2 }, { start: 9, end: 40, speaker: 5 }];
  const out = assignSpeakers(segments, pieces, turns);
  assert.deepEqual(out.map((s) => [s.speaker, s.text]), [[1, "Hi all."], [2, "Me too."], [1, "Agreed. Bye."]]);
  assert.equal(out[1]!.t, t0 + 4000);
  // One voice only: no numbers.
  const one = assignSpeakers(segments, pieces, [{ start: 0, end: 40, speaker: 3 }]);
  assert.ok(one.every((s) => s.speaker === undefined && s.who === "others"));
});

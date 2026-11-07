import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanTranscript, wavFrom } from "./whisper.js";

test("whisper output becomes plain text", () => {
  assert.equal(cleanTranscript("[00:00:00.000 --> 00:00:02.000]  שלום, מה שלומך?\n[BLANK_AUDIO]\n[00:00:02.000 --> 00:00:03.000] Fine.\n"), "שלום, מה שלומך? Fine.");
});

test("a WAV header for 16 kHz mono 16-bit", () => {
  const w = wavFrom(new Float32Array([0, 1, -1]));
  assert.equal(w.toString("ascii", 0, 4), "RIFF");
  assert.equal(w.readUInt32LE(24), 16000);
  assert.equal(w.length, 44 + 6);
  assert.equal(w.readInt16LE(46), 32767);
});

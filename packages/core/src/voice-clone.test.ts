import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VoiceCloner } from "./voice-clone.js";

const wav = (seconds: number) => {
  const b = Buffer.alloc(44 + seconds * 16000 * 2);
  b.write("RIFF", 0);
  return b;
};

test("a voice is kept only with consent, as a real WAV of a sensible length, and can be removed", async () => {
  const v = new VoiceCloner(await mkdtemp(join(tmpdir(), "voice-")), async () => "uv");
  await assert.rejects(v.addVoice("Me", wav(10), false), /permission/);
  await assert.rejects(v.addVoice("Me", Buffer.from("not a wav file at all, no RIFF".repeat(10000)), true), /WAV/);
  await assert.rejects(v.addVoice("Me", wav(2), true), /5 seconds/);
  assert.equal(await v.addVoice("הקול שלי", wav(10), true), "הקול-שלי");
  assert.deepEqual((await v.status()).voices, ["הקול-שלי"]);
  await assert.rejects(v.say("הקול-שלי", "שלום", "he"), /Set up/);
  await v.removeVoice("הקול-שלי");
  assert.deepEqual((await v.status()).voices, []);
  await assert.rejects(v.removeVoice("../x"), /No such voice/);
});

test("splitScript: sentences joined up to a part, paragraphs end with a longer pause, a long sentence cut at a comma", async () => {
  const { splitScript } = await import("./voice-clone.js");
  const r = splitScript("שלום לכולם! זה KesherAI.\n\n" + "משפט ארוך מאוד, ".repeat(20) + "סוף.");
  assert.equal(r.parts[0], "שלום לכולם! זה KesherAI.");
  assert.equal(r.pauses[0], 0.8);
  assert.ok(r.parts.slice(1).every((p) => p.length <= 220));
  assert.match(r.parts[1]!, /,$/);
  assert.equal(r.pauses.at(-1), 0.8);
  assert.equal(r.parts.join(" ").replace(/\s+/g, " ").length > 300, true);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { musicKey, musicLanguage } from "./chat-tools-media.js";

test("make_music: the model's language and key words become what ACE-Step 1.5 lists", () => {
  assert.equal(musicLanguage("he"), "he");
  assert.equal(musicLanguage("Hebrew"), "he");
  assert.equal(musicLanguage("iw"), "he");
  assert.equal(musicLanguage("en-US"), "en");
  assert.equal(musicLanguage("yue"), "yue");
  assert.equal(musicLanguage("klingon"), "en");
  assert.equal(musicLanguage(undefined), "en");
  assert.equal(musicKey("a minor"), "A minor");
  assert.equal(musicKey("Am"), "A minor");
  assert.equal(musicKey("F#"), "F# major");
  assert.equal(musicKey("Bb maj"), "Bb major");
  assert.equal(musicKey("E♭ minor"), "Eb minor");
  assert.equal(musicKey("H major"), undefined);
  assert.equal(musicKey("E#"), undefined);
});

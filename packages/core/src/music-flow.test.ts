import { test } from "node:test";
import assert from "node:assert/strict";
import { pickMusicFlow } from "./chat-tools-media.js";

test("songs: ACE-Step 1.5 XL first, then 1.5, then the first ACE-Step only when it is already here", () => {
  const have = (...ids: string[]) => (id: string) => ids.includes(id);
  assert.equal(pickMusicFlow(have("music-ace-step-15-xl", "music-ace-step-15", "music-ace-step")), "music-ace-step-15-xl");
  assert.equal(pickMusicFlow(have("music-ace-step-15", "music-ace-step")), "music-ace-step-15");
  assert.equal(pickMusicFlow(have("music-ace-step")), "music-ace-step");
  assert.equal(pickMusicFlow(have()), "music-ace-step-15");
});

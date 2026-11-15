import { test } from "node:test";
import assert from "node:assert/strict";
import { applySetting, currentSetting, settingsTool } from "./chat-tools-settings.js";
import type { KesherConfig } from "./config.js";

const config = () => ({ meetings: { keepRecording: false, keepRecordingDays: 30, speakers: true }, notifications: { desktop: true, minSeconds: 60 }, speech: { language: "auto" }, activeModels: {}, remote: { enabled: false } }) as unknown as KesherConfig;

test("change_setting: only listed keys, checked values, always a card with old → new", async () => {
  const c = config();
  let saved = 0;
  const save = () => void saved++;
  assert.match(await applySetting(c, "meetings.keepRecordingDays", 7, save), /30 → 7/);
  assert.equal(currentSetting(c, "meetings.keepRecordingDays"), 7);
  assert.match(await applySetting(c, "meetings.keepRecordingDays", 99999, save), /^Not changed/);
  assert.match(await applySetting(c, "remote.enabled", true, save), /only be changed in Settings/);
  assert.equal((c as unknown as { remote: { enabled: boolean } }).remote.enabled, false, "remote access never changes from a chat");
  assert.match(await applySetting(c, "speech.language", "he; rm -rf", save), /^Not changed/);
  assert.match(await applySetting(c, "activeModels.image", "sdcpp/x/y.gguf", save), /→ sdcpp\/x\/y.gguf/);
  assert.equal(saved, 2);
  const tool = settingsTool(c, save);
  assert.equal(tool.spec.name, "change_setting");
  assert.match(tool.askFirst!({ key: "meetings.keepRecording", value: true }) ?? "", /false → true/, "the card always shows old → new");
});

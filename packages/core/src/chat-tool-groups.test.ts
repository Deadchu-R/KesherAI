import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentTool } from "@kesher/agent";
import { COMPUTER_NOTE, computerGroup, forTelegram } from "./chat-tool-groups.js";

const tool = (name: string): AgentTool => ({ risk: "safe", spec: { name, description: "", inputSchema: { type: "object", properties: {} } }, run: async () => ({ output: "" }) });

test("a chat written from Telegram never gets the screen, the browser or code that runs in a game engine", () => {
  const names = ["read_file", "computer_screenshot", "computer_batch", "browser_open", "make_music", "unity_status", "unity_script_eval", "unity_write_script", "unreal_status", "unreal_python", "unreal_compile", "android_run_on_phone", "remember"];
  const g = forTelegram({ tools: names.map(tool), notes: [COMPUTER_NOTE, "Other line"] });
  assert.deepEqual(g.tools.map((t) => t.spec.name), ["read_file", "make_music", "unity_status", "unreal_status", "remember"]);
  assert.equal(g.notes.includes(COMPUTER_NOTE), false);
  assert.match(g.notes.at(-1)!, /written from Telegram/);
});

test("the computer group's note comes only with its tools", () => {
  assert.deepEqual(computerGroup([]).notes, []);
  assert.deepEqual(computerGroup([tool("computer_screenshot")]).notes, [COMPUTER_NOTE]);
});

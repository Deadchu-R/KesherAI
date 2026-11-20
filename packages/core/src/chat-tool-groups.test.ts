import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentTool } from "@kesher/agent";
import { COMPUTER_NOTE, computerGroup, forTelegram, groupOfTool, groupsByWords, withoutOff } from "./chat-tool-groups.js";

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

test("Hebrew and English requests point at their tool groups by words", () => {
  assert.deepEqual(groupsByWords("תצייר לי חתול"), ["images"]);
  assert.deepEqual(groupsByWords("Draw me a cat"), ["images"]);
  assert.ok(groupsByWords("תפתח את האתר של ynet").includes("browser"));
  assert.ok(groupsByWords("open the website").includes("browser"));
  assert.deepEqual(groupsByWords("תכתוב מסמך על הפרויקט"), ["docs"]);
  assert.ok(groupsByWords("write a report").includes("docs"));
  assert.ok(groupsByWords("שנה את הסצנה ביוניטי").includes("unity"));
  assert.deepEqual(groupsByWords("מה שלומך?"), []);
  // English words match at a word's start only ("cat" is not "catalog"; "page" not in "rampage").
  assert.deepEqual(groupsByWords("a rampage"), []);
});

test("every tool is in at most one group, the first that matches", () => {
  assert.equal(groupOfTool("generate_image"), "images");
  assert.equal(groupOfTool("browser_open"), "browser");
  assert.equal(groupOfTool("search"), "files");
  assert.equal(groupOfTool("web_search"), "web");
  assert.equal(groupOfTool("mcp_github_list"), undefined);
});

test("switches in the + menu take a group's tools and a connector's tools out", () => {
  const tools = ["generate_image", "read_file", "browser_open", "mcp_github_list", "mcp_notion_find"].map(tool);
  const left = withoutOff(tools, ["images", "mcp:github"], (s) => `mcp_${s}_`).map((t) => t.spec.name);
  assert.deepEqual(left, ["read_file", "browser_open", "mcp_notion_find"]);
  assert.equal(withoutOff(tools, [], (s) => s), tools);
});

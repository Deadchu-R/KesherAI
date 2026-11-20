import { test } from "node:test";
import assert from "node:assert/strict";
import { changeRequestText } from "./change-request.js";

const base = { name: "Platformer", projectLine: "[Unity project: Platformer — D:\\Games\\Platformer]", imageLine: "[Attached: D:\\chats\\c1\\change.png]", notes: [], text: "" };

test("the message names the engine in Latin letters, carries the project and picture lines, and asks for approvals", () => {
  const t = changeRequestText({ ...base, engine: "unity", notes: ["1: move the door right", "  ", "2:   make\nthe coin bigger"], text: "Fix the level start" });
  assert.match(t, /^Change request for the Unity project "Platformer", drawn on a screenshot of the Unity view\./);
  assert.ok(t.includes(base.projectLine) && t.includes(base.imageLine));
  assert.ok(t.includes("What I want:\nFix the level start"));
  assert.ok(t.includes("1: move the door right\n2: make the coin bigger"));
  assert.match(t, /unity_\* tools/);
  assert.match(t, /approval card/);
});

test("Unreal and Godot get their own tools; empty notes and text leave no headings", () => {
  const u = changeRequestText({ ...base, engine: "unreal", source: "screen" });
  assert.match(u, /unreal_\* tools/);
  assert.match(u, /screenshot of the computer's screen/);
  assert.ok(!u.includes("What I want:") && !u.includes("The marks on the screenshot:"));
  assert.match(changeRequestText({ ...base, engine: "godot", source: "photo" }), /godot_\* tools[\s\S]*/);
});

test("long text and notes are cut", () => {
  const t = changeRequestText({ ...base, engine: "godot", text: "x".repeat(5000), notes: ["y".repeat(1000)] });
  assert.ok(!t.includes("x".repeat(2001)));
  assert.ok(!t.includes("y".repeat(301)));
});

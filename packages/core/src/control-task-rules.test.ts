import { test } from "node:test";
import assert from "node:assert/strict";
import {
  actionableCount,
  choosePlanner,
  chooseSense,
  frameChanged,
  frameSignature,
  goalAllowsInstall,
  goalRefusal,
  looksSecret,
  parsePlan,
  parseTaskRequest,
  scrubLog,
  stepVerdict,
  targetOf,
} from "./control-task-rules.js";

const frame = (w: number, h: number, fill: (x: number, y: number) => number) => {
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const v = fill(x, y);
      data.set([v, v, v, 255], (y * w + x) * 4);
    }
  return { width: w, height: h, data };
};

test("a request gets its defaults and its limits", () => {
  assert.deepEqual(parseTaskRequest({ goal: " Install Unreal 5.5 from the Epic launcher ", apps: ["EpicGamesLauncher.exe"] }), {
    goal: "Install Unreal 5.5 from the Epic launcher",
    apps: ["EpicGamesLauncher"],
    maxSteps: 40,
    maxMinutes: 15,
    model: "auto",
  });
  assert.ok("error" in parseTaskRequest({}));
  assert.ok("error" in parseTaskRequest({ goal: "x", maxSteps: 0 }));
  assert.ok("error" in parseTaskRequest({ goal: "x", maxMinutes: 500 }));
  assert.ok("error" in parseTaskRequest({ goal: "x", model: "opus" }));
  assert.ok("error" in parseTaskRequest({ goal: "x", apps: ["../evil;rm"] }));
});

test("goals that type secrets, buy or delete for good are refused before anything runs", () => {
  assert.match(goalRefusal("log in to Steam and type my password hunter2") ?? "", /passwords/);
  assert.match(goalRefusal("buy the Megascans pack") ?? "", /buys or pays/);
  // "התקנה" (installing) holds the letters of "קנה" (buy): whole words only.
  assert.equal(goalRefusal("התקנה של Unreal 5.5 מהלאנצ'ר"), undefined);
  assert.match(goalRefusal("לקנות את החבילה") ?? "", /never buys/);
  assert.match(goalRefusal("empty the recycle bin") ?? "", /for good/);
  assert.equal(goalRefusal("install Unreal 5.5 from the Epic launcher"), undefined);
  assert.ok("error" in parseTaskRequest({ goal: "pay for Unity Pro" }));
});

test("installs only when the goal asks for them", () => {
  assert.ok(goalAllowsInstall("install Unreal 5.5"));
  assert.ok(goalAllowsInstall("תתקין את Blender"));
  assert.ok(!goalAllowsInstall("open the project in Unity"));
  const press = (name: string, goal: string) => stepVerdict({ do: "invoke", ref: "u3" }, { goal, target: { type: "Button", name } });
  assert.equal(press("Install", "install Unreal 5.5"), undefined);
  assert.equal(press("Install", "open Unreal")?.kind, "ask");
  assert.equal(press("Download", "rename a file")?.kind, "ask");
});

test("the safety filter refuses passwords, secrets, purchases and permanent deletes", () => {
  const goal = "install Unreal 5.5";
  assert.equal(stepVerdict({ do: "set_value", ref: "u1", value: "hunter2" }, { goal, target: { type: "Edit", name: "x", password: true } })?.kind, "never");
  assert.equal(stepVerdict({ do: "set_value", ref: "u1", value: "1234" }, { goal, target: { type: "Edit", name: "Password" } })?.kind, "never");
  assert.equal(stepVerdict({ do: "type", text: "4111 1111 1111 1111" }, { goal })?.kind, "never");
  assert.equal(stepVerdict({ do: "type", text: "sk-ant-api03abcdefghijklmnopqrstuv" }, { goal })?.kind, "never");
  assert.equal(stepVerdict({ do: "invoke", ref: "u2" }, { goal, target: { type: "Button", name: "Buy now" } })?.kind, "never");
  assert.equal(stepVerdict({ do: "invoke", ref: "u2" }, { goal, target: { type: "Button", name: "Place order ($19.99)" } })?.kind, "never");
  assert.equal(stepVerdict({ do: "invoke", ref: "u2" }, { goal, target: { type: "Button", name: "קנה עכשיו" } })?.kind, "never");
  assert.equal(stepVerdict({ do: "invoke", ref: "u2" }, { goal, target: { type: "MenuItem", name: "Delete permanently" } })?.kind, "never");
  assert.equal(stepVerdict({ do: "key", keys: "shift+delete" }, { goal })?.kind, "never");
  // Ordinary steps pass.
  assert.equal(stepVerdict({ do: "set_value", ref: "u1", value: "Unreal 5.5" }, { goal, target: { type: "Edit", name: "Search" } }), undefined);
  assert.equal(stepVerdict({ do: "invoke", ref: "u2" }, { goal, target: { type: "Button", name: "Library" } }), undefined);
  // A free "Get" on a store page is an install, so it needs the goal (this one asks for it).
  assert.equal(stepVerdict({ do: "invoke", ref: "u2" }, { goal, target: { type: "Button", name: "Get" } }), undefined);
});

test("secrets are recognised without flagging ordinary text", () => {
  assert.ok(looksSecret("4111-1111-1111-1111"));
  assert.ok(looksSecret("GB82 WEST 1234 5698 7654 32"));
  assert.ok(looksSecret("AIzaSyA1234567890abcdefghijklmnopqrstu"));
  assert.ok(!looksSecret("Unreal Engine 5.5.4"));
  assert.ok(!looksSecret("1234 5678 9012 3456")); // fails Luhn: a version or an order number, not a card
  assert.ok(!looksSecret("C:/Program Files/Epic Games"));
});

test("the planner's answer is read even inside fences, and malformed steps are dropped", () => {
  assert.deepEqual(parsePlan('Sure!\n```json\n{"do":"invoke","ref":"u12","note":"open the library {tab}"}\n```'), { do: "invoke", ref: "u12", note: "open the library {tab}" });
  assert.deepEqual(parsePlan('{"do":"click","x":10.5,"y":20}'), { do: "click", x: 10.5, y: 20 });
  assert.equal(parsePlan('{"do":"invoke"}'), undefined); // no ref
  assert.equal(parsePlan('{"do":"format_disk"}'), undefined);
  assert.equal(parsePlan("no json here"), undefined);
  assert.equal(parsePlan('{"do": "done", "summary": "ok"'), undefined); // cut off
});

test("the tree's controls are counted and a ref's element is found", () => {
  const tree = [
    "Window 5 EpicGamesLauncher \"Epic Games Launcher\" on monitor 1, in front. 4 controls:",
    "u1 Pane \"Main\"",
    "  u2 Button \"Library\" [invoke] @10,20",
    "  u3 Edit \"Search\" [set_value] @30,40",
    "  u4 Button \"Install\" disabled [invoke]",
    "  u5 Edit (password field) [set_value]",
  ].join("\n");
  assert.equal(actionableCount(tree), 3);
  assert.deepEqual(targetOf(tree, "u2"), { type: "Button", name: "Library" });
  assert.deepEqual(targetOf(tree, "u5"), { type: "Edit", password: true });
  assert.equal(targetOf(tree, "u9"), undefined);
});

test("change detection ignores a caret and sees a new dialog", () => {
  const base = frame(640, 360, () => 200);
  const caret = frame(640, 360, (x, y) => (x >= 300 && x < 302 && y >= 100 && y < 118 ? 0 : 200));
  const dialog = frame(640, 360, (x, y) => (x >= 160 && x < 480 && y >= 90 && y < 270 ? 40 : 200));
  const a = frameSignature(base);
  assert.equal(frameChanged(a, frameSignature(caret)), false);
  assert.equal(frameChanged(a, frameSignature(dialog)), true);
  assert.equal(frameChanged(undefined, a), true);
});

test("the executor is chosen cheapest first, and the planner is never paid", () => {
  assert.equal(chooseSense({ uia: true, actionable: 12, wantLook: false }), "tree");
  assert.equal(chooseSense({ uia: true, actionable: 2, wantLook: false }), "picture"); // custom-drawn app
  assert.equal(chooseSense({ uia: true, actionable: 12, wantLook: true }), "picture");
  assert.equal(chooseSense({ uia: false, actionable: 0, wantLook: false }), "picture");
  assert.equal(choosePlanner("auto", { gemini: true, local: true }), "gemini");
  assert.equal(choosePlanner("auto", { gemini: true, local: true }, true), "local");
  assert.equal(choosePlanner("auto", { gemini: false, local: true }), "local");
  assert.equal(choosePlanner("auto", { gemini: true, local: false }, true), "gemini");
  assert.equal(choosePlanner("local", { gemini: true, local: false }), undefined);
  assert.equal(choosePlanner("gemini", { gemini: false, local: true }), undefined);
});

test("log lines hide personal paths", () => {
  assert.equal(scrubLog("opened C:\\Users\\someone\\Desktop\\a.txt"), "opened <home>\\Desktop\\a.txt");
  assert.equal(scrubLog("x /home/someone/y\nz"), "x <home>/y z");
});

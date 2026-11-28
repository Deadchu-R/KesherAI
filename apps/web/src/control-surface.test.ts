import { test } from "node:test";
import assert from "node:assert/strict";
import { BUILT_IN, buildSurfaces, itemFromResult } from "./surfaces.js";
import { controlAskMessage, controlFromResult } from "./control-surface.js";

const list = buildSurfaces(BUILT_IN, { parts: [], pluginPages: [] });

test("control surface: registered without a part, phone = view + ask, one lazy card and panel", () => {
  const s = list.find((x) => x.id === "control");
  assert.ok(s, "registered");
  assert.equal(s.phone, "view+ask");
  assert.ok(typeof s.card === "function" && typeof s.panel === "function");
  assert.ok(s.kinds.includes("control"));
});

test("control surface: any successful computer_* step opens the one control item; others and failures do not", () => {
  assert.deepEqual(itemFromResult(list, "computer_click", true, "Pressed"), { surface: "control", kind: "control", id: "live", title: "Computer control" });
  assert.equal(itemFromResult(list, "computer_screenshot", true, "")?.id, "live");
  assert.equal(itemFromResult(list, "computer_click", false, "Denied"), undefined);
  assert.equal(itemFromResult(list, "browser_click", true, ""), undefined);
  assert.equal(controlFromResult("computer_", true) , undefined);
  assert.equal(controlFromResult("computer_type", true)?.id, "live");
});

test("controlAskMessage: the question under a one-line note, in Hebrew and English, with the task when there is one", () => {
  assert.equal(controlAskMessage(" מה על המסך? ", true), "על מה שקורה עכשיו במחשב:\n\nמה על המסך?");
  assert.equal(controlAskMessage("Is it stuck?", false, "Install Unreal"), "About what is on the computer now (task: Install Unreal):\n\nIs it stuck?");
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanShortcuts, comboOf, normalizeCombo, pressMatches, shortcutConflicts, shortcutKey, toAccelerator } from "./shortcuts.js";

test("combinations in one spelling", () => {
  assert.equal(normalizeCombo("ctrl + alt + k"), "Ctrl+Alt+K");
  assert.equal(normalizeCombo("Alt+Control+d"), "Ctrl+Alt+D");
  assert.equal(normalizeCombo("Command+Option+G"), "Cmd+Alt+G");
  assert.equal(normalizeCombo("Ctrl+\\"), "Ctrl+\\");
  assert.equal(normalizeCombo("Ctrl+Alt+Esc"), "Ctrl+Alt+Escape");
  assert.equal(normalizeCombo("Ctrl+F5"), "Ctrl+F5");
  assert.equal(normalizeCombo("Ctrl+K+J"), undefined);
  assert.equal(normalizeCombo("Ctrl+Banana"), undefined);
});

test("a key press: by the key's place (a Hebrew layout still gives K), modifiers alone are nothing", () => {
  assert.equal(comboOf({ key: "ל", code: "KeyK", ctrlKey: true, metaKey: false, altKey: true, shiftKey: false }), "Ctrl+Alt+K");
  assert.equal(comboOf({ key: "Control", code: "ControlLeft", ctrlKey: true, metaKey: false, altKey: false, shiftKey: false }), undefined);
  assert.equal(comboOf({ key: "\\", code: "Backslash", ctrlKey: true, metaKey: false, altKey: false, shiftKey: false }), "Ctrl+\\");
  assert.ok(pressMatches({ key: "k", code: "KeyK", ctrlKey: false, metaKey: true, altKey: false, shiftKey: false }, "Ctrl+K"), "Cmd on a Mac for an app shortcut");
  assert.equal(pressMatches({ key: "k", code: "KeyK", ctrlKey: true, metaKey: false, altKey: false, shiftKey: false }, null), false, "off");
});

test("the user's changes win; off is null; a Mac has its own defaults", () => {
  assert.equal(shortcutKey("dictate", undefined), "Ctrl+Alt+D");
  assert.equal(shortcutKey("dictate", { dictate: "Ctrl+Shift+Space" }), "Ctrl+Shift+Space");
  assert.equal(shortcutKey("dictate", { dictate: null }), null);
  assert.equal(shortcutKey("gameHelper", undefined, true), "Cmd+Alt+G");
  assert.equal(toAccelerator("Ctrl+Alt+K"), "Control+Alt+K");
  assert.equal(toAccelerator("Cmd+Shift+Escape"), "Command+Shift+Escape");
});

test("conflicts, and only valid changes are kept (a global key needs Ctrl, Cmd or Alt)", () => {
  assert.deepEqual(shortcutConflicts({ dictate: "Ctrl+Alt+K" }), [["textHelper", "dictate"]]);
  assert.deepEqual(shortcutConflicts(undefined), []);
  assert.deepEqual(cleanShortcuts({ dictate: "ctrl+alt+x", textHelper: "Shift+K", palette: null, nope: "Ctrl+J", gameHelper: 5 }), { dictate: "Ctrl+Alt+X", palette: null });
});

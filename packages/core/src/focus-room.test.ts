import { test } from "node:test";
import assert from "node:assert/strict";
import { createFocusRoom, focusView, getFocusRoom, joinFocus, setTimer } from "./focus-room.js";
import { cleanGroupLinks } from "@kesher/shared";

test("a focus room: one shared timer through focus and break, and who is here", () => {
  const r = createFocusRoom("Physio", 25, 5, 0);
  assert.equal(focusView(r, undefined, undefined, 0).running, false);
  setTimer(r, true, false, 0);
  assert.deepEqual([focusView(r, undefined, undefined, 60_000).phase, focusView(r, undefined, undefined, 60_000).left], ["focus", 24 * 60]);
  assert.deepEqual([focusView(r, undefined, undefined, 26 * 60_000).phase, focusView(r, undefined, undefined, 26 * 60_000).left], ["break", 4 * 60]);
  assert.equal(focusView(r, undefined, undefined, 31 * 60_000).phase, "focus");
  setTimer(r, false, false, 32 * 60_000);
  assert.equal(focusView(r, undefined, undefined, 99 * 60_000).left, 23 * 60);
  const a = joinFocus(r, "דנה", "פרק 3 <b>", 100_000);
  assert.deepEqual(focusView(r, a, undefined, 100_000).here, [{ name: "דנה", task: "פרק 3 b" }]);
  assert.equal(focusView(r, undefined, undefined, 200_000).here.length, 0);
  assert.equal(getFocusRoom("../x"), undefined);
  assert.throws(() => joinFocus(r, "  ", ""));
});

test("study group links: https only, named", () => {
  assert.deepEqual(cleanGroupLinks([{ url: "https://chat.whatsapp.com/abc" }, { name: "x", url: "javascript:alert(1)" }, { name: "דיסקורד", url: "http://discord.gg/x" }, { name: " קבוצה ", url: "https://t.me/g" }]), [{ name: "chat.whatsapp.com", url: "https://chat.whatsapp.com/abc" }, { name: "קבוצה", url: "https://t.me/g" }]);
});

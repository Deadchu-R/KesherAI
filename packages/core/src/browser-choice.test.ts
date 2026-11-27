import { test } from "node:test";
import assert from "node:assert/strict";
import { chooseBrowser, namedBrowser, needsOwnSignIn } from "./browser-choice.js";
import { BrowserBridge } from "./browser-bridge.js";

test("needsOwnSignIn: the user's own account, in Hebrew and English", () => {
  assert.equal(needsOwnSignIn("check my account balance"), true);
  assert.equal(needsOwnSignIn("תבדוק בחשבון שלי אם יש הזמנה"), true);
  assert.equal(needsOwnSignIn("open Gmail and find the invoice"), true);
  assert.equal(needsOwnSignIn("מה המחיר של אוזניות Aurora בחנות"), false);
  assert.equal(needsOwnSignIn(undefined), false);
});

test("namedBrowser: only when the user names one", () => {
  assert.equal(namedBrowser("do it in my Chrome please"), "chrome");
  assert.equal(namedBrowser("תפתח את זה בכרום"), "chrome");
  assert.equal(namedBrowser("use KesherAI's browser"), "pane");
  assert.equal(namedBrowser("find a recipe"), undefined);
});

test("chooseBrowser: setting × availability × what the user named", () => {
  const both = { pane: true, chrome: true };
  // Settings with both there.
  assert.deepEqual(chooseBrowser({ ...both, preferred: "pane", lastUser: "my account" }), { browser: "pane" });
  assert.deepEqual(chooseBrowser({ ...both, preferred: "chrome", lastUser: "find a recipe" }), { browser: "chrome" });
  assert.deepEqual(chooseBrowser({ ...both, preferred: "auto", lastUser: "find a recipe" }), { browser: "pane" });
  assert.deepEqual(chooseBrowser({ ...both, lastUser: "בחשבון שלי" }), { browser: "chrome" });
  // The preferred one is missing: the other, silently.
  assert.deepEqual(chooseBrowser({ pane: false, chrome: true, preferred: "pane" }), { browser: "chrome" });
  assert.deepEqual(chooseBrowser({ pane: true, chrome: false, preferred: "chrome" }), { browser: "pane" });
  assert.deepEqual(chooseBrowser({ pane: true, chrome: false, preferred: "auto", lastUser: "open Gmail" }), { browser: "pane" });
  // The user named one: it wins over the setting; unavailable means ask, never switch.
  assert.deepEqual(chooseBrowser({ ...both, preferred: "pane", lastUser: "in my Chrome" }), { browser: "chrome" });
  const ask = chooseBrowser({ pane: true, chrome: false, preferred: "auto", lastUser: "in my Chrome" });
  assert.ok("ask" in ask && /ask_user/.test(ask.ask));
  assert.ok("ask" in chooseBrowser({ pane: false, chrome: true, lastUser: "use KesherAI's browser" }));
});

test("take over: the model's command waits until the user gives back", async () => {
  const b = new BrowserBridge();
  assert.equal(await b.waitForGiveBack(), false, "nothing to wait for");
  b.setTakeOver(true);
  assert.equal(b.takenOver(), true);
  assert.equal(b.activity().takenOver, true);
  let released = false;
  const waiting = b.waitForGiveBack().then((w) => ((released = true), w));
  await new Promise((r) => setImmediate(r));
  assert.equal(released, false, "still waiting while the user has it");
  b.setTakeOver(false);
  assert.equal(await waiting, true, "told it had to wait, so the model gets a fresh look");
  assert.equal(b.takenOver(), false);
});

test("take over: Stop ends the wait and the take-over; a chat's abort ends only its wait", async () => {
  const b = new BrowserBridge();
  b.setTakeOver(true);
  const ctl = new AbortController();
  const w = b.waitForGiveBack(ctl.signal);
  ctl.abort();
  await assert.rejects(w, /Stopped/);
  assert.equal(b.takenOver(), true);
  const w2 = b.waitForGiveBack();
  b.stop();
  assert.equal(await w2, true);
  assert.equal(b.takenOver(), false);
});

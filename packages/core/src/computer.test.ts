import { test } from "node:test";
import assert from "node:assert/strict";
import { ComputerControl, appKind, isSensitiveWindow, sendKeysCombo, sendKeysText } from "./computer.js";

function fake(front: { app: string; title: string }) {
  const done: string[] = [];
  return {
    done,
    front,
    be: {
      screenshot: async () => ({ png: Buffer.from("png"), scale: 0.5, width: 1280, height: 720 }),
      foreground: async () => front,
      click: async (x: number, y: number) => void done.push(`click ${x},${y}`),
      move: async () => undefined,
      type: async (t: string) => void done.push(`type ${t}`),
      key: async (k: string) => void done.push(`key ${k}`),
      scroll: async () => undefined,
    },
  };
}

test("computer control: per-app approval, browsers view-only, terminals click-only, no typing in password windows, stop", async () => {
  const f = fake({ app: "notepad", title: "Untitled - Notepad" });
  const stopped: string[][] = [];
  let on = false;
  const cc = new ComputerControl(() => on, (ids) => stopped.push(ids), f.be);
  assert.deepEqual(cc.tools("c1"), [], "no tools while it is off");
  on = true;
  const tool = (n: string) => cc.tools("c1").find((t) => t.spec.name === n)!;
  const ctx = { signal: new AbortController().signal, recordChange: () => undefined };
  await assert.rejects(tool("computer_screenshot").run({}, ctx), /computer_use_app/);
  await tool("computer_use_app").run({ app: "Notepad" }, ctx);
  const shot = await tool("computer_screenshot").run({}, ctx);
  assert.equal(shot.images?.[0]?.mimeType, "image/png");
  await tool("computer_click").run({ x: 100, y: 50 }, ctx);
  assert.deepEqual(f.done, ["click 200,100"], "screenshot coordinates are scaled back to the screen");
  await tool("computer_type").run({ text: "hello" }, ctx);

  f.front.app = "chrome";
  await assert.rejects(tool("computer_click").run({ x: 1, y: 1 }, ctx), /browser/);
  f.front.app = "WindowsTerminal";
  await assert.rejects(tool("computer_type").run({ text: "rm -rf" }, ctx), /terminal/);
  f.front.app = "notepad";
  f.front.title = "Sign in to your account";
  await assert.rejects(tool("computer_type").run({ text: "secret" }, ctx), /password, sign-in or payment/);
  f.front.app = "excel";
  f.front.title = "Book1";
  await assert.rejects(tool("computer_click").run({ x: 1, y: 1 }, ctx), /not allowed/);

  cc.stop();
  assert.deepEqual(stopped, [["c1"]]);
  f.front.app = "notepad";
  await assert.rejects(tool("computer_click").run({ x: 1, y: 1 }, ctx), /pressed Stop/);
  assert.ok(cc.status().log.length > 5);
});

test("helpers", () => {
  assert.equal(appKind("msedge.exe"), "view-only");
  assert.equal(appKind("explorer"), "click-only");
  assert.equal(appKind("Unity"), "full");
  assert.equal(isSensitiveWindow("PayPal Checkout"), true);
  assert.equal(isSensitiveWindow("התחברות לחשבון"), true);
  assert.equal(sendKeysCombo("ctrl+s"), "^s");
  assert.equal(sendKeysCombo("alt+f4"), "%{F4}");
  assert.equal(sendKeysText("a+b{c}\n"), "a{+}b{{}c{}}{ENTER}");
});

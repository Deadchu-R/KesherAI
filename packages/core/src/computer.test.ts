import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ComputerControl,
  appKind,
  isSensitiveWindow,
  sendKeysCombo,
  sendKeysText,
} from "./computer.js";

function fake(front: { app: string; title: string }) {
  const done: string[] = [];
  return {
    done,
    front,
    be: {
      screenshot: async () => ({
        png: Buffer.from("png"),
        scale: 0.5,
        width: 1280,
        height: 720,
      }),
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
  const cc = new ComputerControl(
    () => on,
    (ids) => stopped.push(ids),
    f.be,
  );
  assert.deepEqual(cc.tools("c1"), [], "no tools while it is off");
  on = true;
  const tool = (n: string) => cc.tools("c1").find((t) => t.spec.name === n)!;
  const ctx = {
    signal: new AbortController().signal,
    recordChange: () => undefined,
  };
  await assert.rejects(
    tool("computer_screenshot").run({}, ctx),
    /computer_use_app/,
  );
  await tool("computer_use_app").run({ app: "Notepad" }, ctx);
  const shot = await tool("computer_screenshot").run({}, ctx);
  assert.equal(shot.images?.[0]?.mimeType, "image/png");
  await tool("computer_click").run({ x: 100, y: 50 }, ctx);
  assert.deepEqual(
    f.done,
    ["click 200,100"],
    "screenshot coordinates are scaled back to the screen",
  );
  await tool("computer_type").run({ text: "hello" }, ctx);

  f.front.app = "chrome";
  await assert.rejects(
    tool("computer_click").run({ x: 1, y: 1 }, ctx),
    /browser/,
  );
  f.front.app = "WindowsTerminal";
  await assert.rejects(
    tool("computer_type").run({ text: "rm -rf" }, ctx),
    /terminal/,
  );
  f.front.app = "notepad";
  f.front.title = "Sign in to your account";
  await assert.rejects(
    tool("computer_type").run({ text: "secret" }, ctx),
    /password, sign-in or payment/,
  );
  f.front.app = "excel";
  f.front.title = "Book1";
  await assert.rejects(
    tool("computer_click").run({ x: 1, y: 1 }, ctx),
    /not allowed/,
  );

  cc.stop();
  assert.deepEqual(stopped, [["c1"]]);
  f.front.app = "notepad";
  await assert.rejects(
    tool("computer_click").run({ x: 1, y: 1 }, ctx),
    /pressed Stop/,
  );
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

test("watching the screen: only while computer control is on", async () => {
  let on = false;
  const f = fake({ app: "notepad", title: "x" });
  const cc = new ComputerControl(
    () => on,
    () => undefined,
    f.be,
  );
  await assert.rejects(cc.watch(), /off/);
  on = true;
  assert.equal((await cc.watch(800)).toString(), "png");
});

test("batch, zoom, other monitors and bringing an app to the front", async () => {
  const f = fake({ app: "notepad", title: "x" });
  const zooms: number[][] = [];
  const be = {
    ...f.be,
    screenshot: async () => ({
      png: Buffer.from("png"),
      scale: 0.5,
      width: 1280,
      height: 720,
      left: -2560,
      top: 0,
    }),
    zoom: async (x: number, y: number, w: number, h: number) => (
      zooms.push([x, y, w, h]),
      { png: Buffer.from("z"), width: 400, height: 200 }
    ),
    drag: async (x1: number, y1: number, x2: number, y2: number) =>
      void f.done.push(`drag ${x1},${y1}→${x2},${y2}`),
    activate: async () => true,
  };
  const cc = new ComputerControl(
    () => true,
    () => undefined,
    be,
  );
  const tool = (n: string) => cc.tools("c1").find((t) => t.spec.name === n)!;
  const ctx = {
    signal: new AbortController().signal,
    recordChange: () => undefined,
  };
  await tool("computer_use_app").run({ app: "notepad" }, ctx);
  await assert.rejects(
    tool("computer_open_app").run({ app: "excel" }, ctx),
    /not allowed/,
  );
  assert.match(
    (await tool("computer_open_app").run({ app: "notepad" }, ctx)).output,
    /front/,
  );
  await tool("computer_screenshot").run({}, ctx);
  await tool("computer_click").run({ x: 100, y: 50 }, ctx);
  assert.equal(
    f.done.at(-1),
    "click -2360,100",
    "a monitor left of the main one",
  );
  await assert.rejects(
    tool("computer_click").run({ x: 5000, y: 50 }, ctx),
    /outside/,
  );
  const z = await tool("computer_zoom").run(
    { x: 10, y: 10, width: 100, height: 50 },
    ctx,
  );
  assert.equal(z.images?.length, 1);
  assert.deepEqual(zooms[0], [-2540, 20, 200, 100]);
  const r = await tool("computer_batch").run(
    {
      actions: [
        { action: "click", x: 10, y: 10 },
        { action: "type", text: "hi" },
        { action: "key", keys: "enter" },
        { action: "drag", x: 0, y: 0, to_x: 10, to_y: 10 },
      ],
    },
    ctx,
  );
  assert.match(r.output, /4 of 4/);
  assert.equal(r.images?.length, 1, "one screenshot at the end");
  f.front.title = "Sign in";
  const r2 = await tool("computer_batch").run(
    {
      actions: [
        { action: "click", x: 1, y: 1 },
        { action: "type", text: "pw" },
        { action: "key", keys: "enter" },
      ],
    },
    ctx,
  );
  assert.match(r2.output, /1 of 3.*password, sign-in or payment/);
  assert.equal(r2.isError, true);
});

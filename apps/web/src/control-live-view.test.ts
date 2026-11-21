import { test } from "node:test";
import assert from "node:assert/strict";
import { liveSources, pickSource, type LiveState } from "./control-live-view";

const base = (o: Partial<LiveState> = {}): Pick<LiveState, "browser" | "computer" | "log"> => ({
  browser: { active: false, pane: true },
  computer: { enabled: true, active: false, app: "" },
  log: [],
  ...o,
});
const act = (kind: "browser" | "computer", action: string, where?: string) => ({ at: "2026-11-21T10:00:00Z", kind, action, ok: true, ...(where ? { where } : {}) });

test("the pictures there are: the pane, a driven Chrome tab, the screen when computer control is on", () => {
  assert.deepEqual(liveSources(base()), ["pane", "computer"]);
  assert.deepEqual(liveSources(base({ browser: { active: true, pane: false, chrome: "shop.example" }, computer: { enabled: false, active: false, app: "" } })), ["chrome"]);
});

test("the picture follows the last action unless the user picked one", () => {
  assert.equal(pickSource(base({ log: [act("computer", "click", "notepad")] })), "computer");
  assert.equal(pickSource(base({ log: [act("computer", "click"), act("browser", "browser_click", "a.com"), act("browser", "stop")] })), "pane");
  const chrome = base({ browser: { active: true, pane: true, chrome: "shop.example" }, log: [act("browser", "browser_click", "shop.example")] });
  assert.equal(pickSource(chrome), "chrome");
  assert.equal(pickSource(chrome, "computer"), "computer");
  // A pick that no longer exists falls back.
  assert.equal(pickSource(base({ computer: { enabled: false, active: false, app: "" } }), "computer"), "pane");
  assert.equal(pickSource(base({ browser: { active: false, pane: false }, computer: { enabled: false, active: false, app: "" } })), undefined);
});

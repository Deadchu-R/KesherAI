import { test } from "node:test";
import assert from "node:assert/strict";
import { ControlWatchers, controlNoteDelay, isControlTool, mergeControlLog, WATCH_MS } from "./control-live.js";

test("the browser and computer logs merge in time order, one Stop shown once", () => {
  const log = mergeControlLog(
    [
      { at: "2026-11-21T10:00:01.000Z", tool: "browser_click", site: "a.com", target: 'button "Go"', ok: true },
      { at: "2026-11-21T10:00:05.000Z", tool: "stop", ok: true, note: "Stopped by the user" },
    ],
    [
      { at: "2026-11-21T10:00:03.000Z", conversationId: "c", action: "click", app: "notepad", ok: false, note: "denied" },
      { at: "2026-11-21T10:00:05.100Z", conversationId: "-", action: "stop", app: "", ok: true },
    ],
  );
  assert.deepEqual(log.map((a) => `${a.kind}:${a.action}:${a.where ?? ""}`), ["browser:browser_click:a.com", "computer:click:notepad", "browser:stop:"]);
  assert.equal(log[1]!.note, "denied");
});

test("control tools and the shorter note delay", () => {
  assert.ok(isControlTool("browser_click") && isControlTool("computer_tree"));
  assert.ok(!isControlTool("run_command"));
  assert.equal(controlNoteDelay(60), 10);
  assert.equal(controlNoteDelay(3), 3);
});

test("a chat counts as watched for a while after a screen said so; the live view covers every chat", () => {
  const w = new ControlWatchers();
  w.mark(["c1"], 1000);
  assert.ok(w.watching("c1", 1000 + WATCH_MS - 1));
  assert.ok(!w.watching("c1", 1000 + WATCH_MS + 1));
  assert.ok(!w.watching("c2", 1000));
  w.mark(["*"], 5000);
  assert.ok(w.watching("c2", 5001));
  w.mark(["../x"], 5000);
  assert.ok(!w.watching("../x", 99_999));
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { appLines, crashSummary } from "./android-phone.js";

const LOG = [
  "11-09 12:05:48.950  3407  3584 I ActivityManager: Start proc 7735:com.kesherai.autoshooter/u0a914 for next-top-activity {com.kesherai.autoshooter/com.epicgames.unreal.SplashActivity}",
  "11-09 12:05:49.000  5000  5001 I OtherApp: private message from another app",
  "11-09 12:05:50.100  7735  7790 D UE      : [2026.11.09-10.05.50:100][  0]LogInit: Build: ++UE5+Release-5.8",
  "11-09 12:05:51.600  7735  7790 E UE      : Fatal error: [File:Engine.cpp] Failed to enter /Engine/Maps/Entry",
  "11-09 12:05:51.700  9999  9999 F DEBUG   : *** *** *** *** *** *** *** *** *** *** *** *** *** *** *** ***",
  "11-09 12:05:51.701  9999  9999 F DEBUG   : pid: 1234, tid: 1234, name: other  >>> com.other.app <<<",
  "11-09 12:05:51.702  9999  9999 F DEBUG   : #00 pc 000 /system/lib64/libc.so (abort)",
].join("\n");

test("keeps only the app's own lines", () => {
  const mine = appLines(LOG, "com.kesherai.autoshooter");
  assert.equal(
    mine.some((l) => l.includes("OtherApp")),
    false,
  );
  assert.equal(
    mine.some((l) => l.includes("com.other.app")),
    false,
  );
  assert.equal(
    mine.some((l) => l.includes("Fatal error")),
    true,
  );
  assert.equal(
    mine.some((l) => l.includes("LogInit")),
    true,
  );
});
test("keeps a native crash report that names the app", () => {
  const log = `${LOG}\n11-09 12:06:00.001  9998  9998 F DEBUG   : pid: 7735, tid: 7790, name: GameThread  >>> com.kesherai.autoshooter <<<\n11-09 12:06:00.002  9998  9998 F DEBUG   : #00 pc 0012 libUnreal.so`;
  const mine = appLines(log, "com.kesherai.autoshooter");
  assert.equal(
    mine.some((l) => l.includes("libUnreal.so")),
    true,
  );
});
test("puts the fatal line in the summary", () => {
  assert.match(
    crashSummary(appLines(LOG, "com.kesherai.autoshooter")).join("\n"),
    /Failed to enter/,
  );
});

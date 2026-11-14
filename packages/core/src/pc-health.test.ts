import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { folderSize, healthItems, healthPrompt, type HealthReading } from "./pc-health.js";

const GB = 1024 ** 3;
const base: HealthReading = { at: "", platform: "win32", drives: [{ name: "C:", freeBytes: 50 * GB, totalBytes: 500 * GB }], kesher: [], windowsOld: false, restartPending: false, startup: [], ram: { usedBytes: 8 * GB, totalBytes: 32 * GB }, gpus: [], uptimeHours: 5 };

test("a healthy computer gets one 'fine' line", () => {
  assert.deepEqual(healthItems(base).map((i) => i.level), ["ok"]);
});

test("rules: a full drive, Windows.old, a hot card, big models folder", () => {
  const items = healthItems({ ...base, drives: [{ name: "C:", freeBytes: 27 * 1024 ** 2, totalBytes: 500 * GB }], windowsOld: true, gpus: [{ name: "RTX", temp: 88, memUsedBytes: 1, memTotalBytes: 10 }], kesher: [{ name: "models", path: "x", bytes: 120 * GB }] }, true);
  assert.equal(items[0]!.level, "bad");
  assert.match(items[0]!.title, /C:.*0 GB/);
  assert.ok(items.some((i) => /Windows\.old/.test(i.title)));
  assert.ok(items.some((i) => /RTX.*88/.test(i.title) && i.level === "bad"));
  assert.ok(items.some((i) => /models.*120 GB/.test(i.title) && /המודלים/.test(i.fix)));
  assert.match(healthPrompt(base, items, true), /Hebrew[\s\S]*Never suggest deleting/);
});

test("folderSize counts files and stops at its limit", async () => {
  const d = mkdtempSync(join(tmpdir(), "fs-"));
  mkdirSync(join(d, "a"));
  writeFileSync(join(d, "a", "x"), "12345");
  writeFileSync(join(d, "y"), "123");
  assert.deepEqual(await folderSize("t", d), { name: "t", path: d, bytes: 8 });
  assert.equal((await folderSize("t", d, 1)).partial, true);
});

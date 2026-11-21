import { test } from "node:test";
import assert from "node:assert/strict";
import { RateMeter, classifyDownloadError, driveWithRoom, hasHeadroom, headroomBytes, secondsLeft } from "./progress.js";

const GIB = 1024 ** 3;

test("RateMeter: the first window sets the rate, later ones move it only part of the way", () => {
  const m = new RateMeter(0.5);
  assert.equal(m.value, 0);
  assert.equal(m.add(10_000_000, 1000), 10_000_000);
  // One slow second (2 MB/s) pulls the rate to the middle, not down to 2 MB/s.
  assert.equal(m.add(2_000_000, 1000), 6_000_000);
  assert.equal(m.add(2_000_000, 1000), 4_000_000);
});

test("RateMeter: window length counts, an empty window decays and reset starts over", () => {
  const m = new RateMeter(0.3);
  m.add(1000, 500); // 2000 B/s
  assert.equal(m.value, 2000);
  m.add(0, 1000);
  assert.equal(m.value, 1400);
  assert.equal(m.add(5, 0), 1400, "a zero-length window is ignored");
  m.reset();
  assert.equal(m.value, 0);
});

test("secondsLeft: rounds up, and is undefined without a rate or nothing left", () => {
  assert.equal(secondsLeft(10 * 1024 ** 2, 1024 ** 2), 10);
  assert.equal(secondsLeft(1500, 1000), 2);
  assert.equal(secondsLeft(1000, 0), undefined);
  assert.equal(secondsLeft(0, 1000), undefined);
});

test("headroom is the size plus 10% plus 2 GB", () => {
  assert.equal(headroomBytes(10 * GIB), Math.ceil(11 * GIB + 2 * GIB));
  assert.equal(hasHeadroom(13 * GIB, 10 * GIB), true);
  assert.equal(hasHeadroom(13 * GIB - 1, 10 * GIB), false);
  assert.equal(hasHeadroom(undefined, 10 * GIB), true, "unknown free space is let through");
});

test("driveWithRoom offers the other drive only when the file fits there", () => {
  const drives = [{ id: "heavy", freeGb: 8 }, { id: "models", freeGb: 200 }];
  assert.equal(driveWithRoom(drives, "heavy", 10 * GIB), "models");
  assert.equal(driveWithRoom(drives, "models", 10 * GIB), undefined, "8 GB free is below 10 + 10% + 2");
  assert.equal(driveWithRoom([{ id: "heavy" }, { id: "models", freeGb: 5 }], "models", 10 * GIB), undefined, "unknown space is not offered");
});

test("classifyDownloadError: each cause", () => {
  assert.equal(classifyDownloadError("Not enough disk space: this needs 9 GB, and only 2 GB is free"), "disk-full");
  assert.equal(classifyDownloadError("ENOSPC: no space left on device, write"), "disk-full");
  assert.equal(classifyDownloadError("HTTP 401 Unauthorized"), "auth");
  assert.equal(classifyDownloadError("HTTP 403 Forbidden"), "auth");
  assert.equal(classifyDownloadError("fetch failed: ETIMEDOUT"), "network");
  assert.equal(classifyDownloadError("terminated: ECONNRESET"), "network");
  assert.equal(classifyDownloadError("HTTP 503 Service Unavailable"), "network");
  assert.equal(classifyDownloadError("HTTP 416 Range Not Satisfiable"), "changed");
  assert.equal(classifyDownloadError("SHA-256 mismatch: expected a, got b"), "changed");
  assert.equal(classifyDownloadError("HTTP 404 Not Found"), "other");
  assert.equal(classifyDownloadError("something odd"), "other");
});

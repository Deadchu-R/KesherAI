import { test } from "node:test";
import assert from "node:assert/strict";
import { guardStore, HubStorageError, secondsToUtcMidnight, storageCode } from "./storage-guard.js";

test("guardStore turns storage throws into HubStorageError (a quota message is a limit), and passes results through", () => {
  const raw = {
    ok: () => 7,
    quota: () => {
      throw new Error("Exceeded allowed rows written in Durable Objects free tier.");
    },
    other: () => {
      throw new Error("no such table: x");
    },
  };
  const g = guardStore(raw);
  assert.equal(g.ok(), 7);
  assert.throws(() => g.quota(), (e: unknown) => e instanceof HubStorageError && storageCode(e) === "hub-storage-limit");
  assert.throws(() => g.other(), (e: unknown) => storageCode(e) === "hub-storage-error");
  assert.equal(storageCode(new Error("x")), undefined);
});

test("secondsToUtcMidnight counts to the next 00:00 UTC, at least a minute", () => {
  assert.equal(secondsToUtcMidnight(Date.UTC(2026, 10, 22, 23, 0, 0)), 3600);
  assert.equal(secondsToUtcMidnight(Date.UTC(2026, 10, 22, 23, 59, 30)), 60);
  assert.equal(secondsToUtcMidnight(Date.UTC(2026, 10, 22, 0, 0, 0)), 86400);
});

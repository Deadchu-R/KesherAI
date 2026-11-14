import { test } from "node:test";
import assert from "node:assert/strict";
import { batteryWear, patchAgeDays } from "./phone-health.js";

test("the battery's wear and the security update's age", () => {
  assert.equal(batteryWear({ batteryNowFullMah: 4100, batteryDesignMah: 5000 }), 82);
  assert.equal(batteryWear({ batteryNowFullMah: 5200, batteryDesignMah: 5000 }), 100);
  assert.equal(batteryWear({ batteryNowFullMah: 4100 }), undefined);
  assert.equal(patchAgeDays("2026-08-01", Date.parse("2026-11-09")), 100);
  assert.equal(patchAgeDays("not a date"), undefined);
});

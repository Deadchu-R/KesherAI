import { test } from "node:test";
import assert from "node:assert/strict";
import { batteryWear, patchAgeDays, phoneItems } from "./phone-health.js";

test("the battery's wear and the security update's age", () => {
  assert.equal(batteryWear({ batteryNowFullMah: 4100, batteryDesignMah: 5000 }), 82);
  assert.equal(batteryWear({ batteryNowFullMah: 5200, batteryDesignMah: 5000 }), 100);
  assert.equal(batteryWear({ batteryNowFullMah: 4100 }), undefined);
  assert.equal(patchAgeDays("2026-08-01", Date.parse("2026-11-09")), 100);
  assert.equal(patchAgeDays("not a date"), undefined);
});

test("phone readings kept over time, and what they say about charging", async () => {
  const { addSample, chargingHabits } = await import("./phone-health.js");
  let list = addSample([], { at: 0, percent: 50, tempC: 30, charging: true, wear: 92 });
  list = addSample(list, { at: 10 * 60_000, percent: 60, tempC: 31, charging: true, wear: 92 });
  assert.equal(list.length, 1, "within half an hour: replaced");
  list = addSample(list, { at: 60 * 60_000, percent: 98, tempC: 39, charging: true, wear: 91 });
  list = addSample(list, { at: 120 * 60_000, percent: 80, tempC: 33, charging: false, wear: 91 });
  const h = chargingHabits(list);
  assert.deepEqual(h, { samples: 3, chargingSamples: 2, hotCharging: 1, nearFull: 1, maxTempC: 39, wearFrom: 92, wearTo: 91 });
});

test("phone rules: wear, cycles, hot full charge, uptime, old patch, and 'fine' when nothing is wrong", () => {
  const now = Date.parse("2026-11-15");
  const titles = (p: Parameters<typeof phoneItems>[0]) => phoneItems(p, false, now).map((i) => `${i.level}: ${i.title}`);
  assert.deepEqual(titles({}), ["ok: The phone looks fine"]);
  assert.deepEqual(titles({ batteryNowFullMah: 3900, batteryDesignMah: 5000 }), ["bad: The battery holds about 78% of its original capacity"]);
  assert.deepEqual(titles({ batteryNowFullMah: 4300, batteryDesignMah: 5000 }), ["warn: The battery holds about 86% of its original capacity"]);
  assert.deepEqual(titles({ batteryNowFullMah: 4500, batteryDesignMah: 5000 }), ["ok: The phone looks fine"]);
  assert.deepEqual(titles({ batteryCycles: 800 }), ["warn: 800 charge cycles"]);
  assert.deepEqual(titles({ batteryCycles: 799 }), ["ok: The phone looks fine"]);
  assert.deepEqual(titles({ charging: true, batteryPercent: 96, batteryTempC: 38 }), ["warn: Fully charged while warm"]);
  assert.deepEqual(titles({ charging: false, batteryPercent: 96, batteryTempC: 38 }), ["ok: The phone looks fine"]);
  assert.deepEqual(titles({ uptimeHours: 24 * 9 }), ["warn: The phone has not restarted in 9 days"]);
  assert.deepEqual(titles({ securityPatch: "2026-07-01" }), ["warn: The phone's security update is old"]);
  assert.deepEqual(titles({ securityPatch: "2026-03-01" }), ["bad: The phone's security update is 8 months old"]);
  assert.equal(phoneItems({ batteryCycles: 900 }, true, now)[0]!.title.includes("מחזורי טעינה"), true);
});

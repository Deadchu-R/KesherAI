/** Phone Health numbers worked out from the phone app's reading (pages/HealthPage.tsx). */

/** The battery's capacity now against new, as a percent (AccuBattery's estimate), when the phone reports both. */
export function batteryWear(p: { batteryNowFullMah?: number; batteryDesignMah?: number }): number | undefined {
  if (!p.batteryNowFullMah || !p.batteryDesignMah || p.batteryDesignMah < 500) return undefined;
  return Math.min(100, Math.round((p.batteryNowFullMah / p.batteryDesignMah) * 100));
}

/** Days since the phone's security update ("2026-08-05"), or undefined. */
export function patchAgeDays(patch: string | undefined, now = Date.now()): number | undefined {
  const t = patch ? Date.parse(patch) : NaN;
  return Number.isFinite(t) ? Math.floor((now - t) / 86_400_000) : undefined;
}

/** One kept phone reading (for the habits over time). */
export interface PhoneSample { at: number; percent?: number; tempC?: number; charging?: boolean; wear?: number }

/**
 * Adds a reading to the kept ones: at most one per half hour, the last 240 (about five days of readings at most).
 *
 * @param list - The kept readings, oldest first.
 * @param s - The new one.
 */
export function addSample(list: PhoneSample[], s: PhoneSample): PhoneSample[] {
  const last = list[list.length - 1];
  const next = last && s.at - last.at < 30 * 60_000 ? [...list.slice(0, -1), s] : [...list, s];
  return next.slice(-240);
}

/** What the kept readings say about charging (as AccuBattery's habits): heat and full charges while charging. */
export function chargingHabits(list: PhoneSample[]): { samples: number; chargingSamples: number; hotCharging: number; nearFull: number; maxTempC?: number; wearFrom?: number; wearTo?: number } {
  const charging = list.filter((x) => x.charging);
  const temps = list.map((x) => x.tempC).filter((t): t is number => typeof t === "number" && t > 0);
  const wears = list.map((x) => x.wear).filter((w): w is number => typeof w === "number");
  return {
    samples: list.length,
    chargingSamples: charging.length,
    hotCharging: charging.filter((x) => (x.tempC ?? 0) >= 38).length,
    nearFull: charging.filter((x) => (x.percent ?? 0) >= 95).length,
    ...(temps.length ? { maxTempC: Math.max(...temps) } : {}),
    ...(wears.length >= 2 ? { wearFrom: wears[0]!, wearTo: wears[wears.length - 1]! } : {}),
  };
}

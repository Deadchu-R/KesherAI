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

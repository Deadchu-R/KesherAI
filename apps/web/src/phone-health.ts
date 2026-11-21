/** Phone Health numbers worked out from the phone app's reading (pages/HealthPage.tsx). */

/** The battery's capacity now against new, as a percent (AccuBattery's estimate), when the phone reports both. */
export function batteryWear(p: { batteryNowFullMah?: number; batteryDesignMah?: number }): number | undefined {
  if (!p.batteryNowFullMah || !p.batteryDesignMah || p.batteryDesignMah < 500) return undefined;
  return Math.min(100, Math.round((p.batteryNowFullMah / p.batteryDesignMah) * 100));
}

/** What the browser's `navigator.connection` reports (all optional; not every WebView has it). */
export interface ConnectionLike { type?: string; effectiveType?: string; downlink?: number; saveData?: boolean }

/** The phone's network, shaped for the Health page. */
export interface PhoneNetwork { kind: "wifi" | "cellular" | "ethernet" | "offline" | "unknown"; speed?: string; saveData: boolean }

/**
 * The phone's network type from `navigator.connection` (cheap: no permission, no native call).
 *
 * @param c - `navigator.connection`, if there is one.
 * @param online - `navigator.onLine`.
 */
export function phoneNetwork(c: ConnectionLike | undefined, online = true): PhoneNetwork {
  const saveData = !!c?.saveData;
  if (!online) return { kind: "offline", saveData };
  const kind = c?.type === "wifi" || c?.type === "cellular" || c?.type === "ethernet" ? c.type : "unknown";
  // WebView often hides the type but gives the speed class ("4g"); a speed class alone means mobile data is likely.
  const speed = c?.effectiveType && /^(slow-2g|2g|3g|4g)$/.test(c.effectiveType) ? c.effectiveType.toUpperCase() : undefined;
  const mbps = typeof c?.downlink === "number" && c.downlink > 0 && c.downlink < 10_000 ? `${Math.round(c.downlink * 10) / 10} Mbps` : undefined;
  return { kind, ...(speed || mbps ? { speed: [speed, mbps].filter(Boolean).join(" · ") } : {}), saveData };
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

/** What the phone app's native side reads (Android's own APIs). */
export interface PhoneReading { storageFree?: number; storageTotal?: number; ramFree?: number; ramTotal?: number; lowMemory?: boolean; batteryPercent?: number; batteryTempC?: number; batteryHealth?: string; charging?: boolean; modelsBytes?: number; model?: string; android?: string; batteryCycles?: number; batteryNowFullMah?: number; batteryDesignMah?: number; batteryVoltageMv?: number; thermal?: number; powerSave?: boolean; uptimeHours?: number; securityPatch?: string }

/** One thing to do (or "fine"). */
export interface PhoneItem { level: "ok" | "warn" | "bad"; title: string; fix: string }

const GB = 1024 ** 3;
const gb = (b: number) => (b >= 10 * GB ? Math.round(b / GB) : Math.round((b / GB) * 10) / 10);

/**
 * What to do about the phone, from fixed rules (like the computer's).
 *
 * @param p - The phone's reading.
 * @param he - Hebrew text (else English).
 * @param now - The time (tests pass their own).
 * @returns The items, worst first as found; one "fine" item when nothing is wrong.
 */
export function phoneItems(p: PhoneReading, he: boolean, now = Date.now()): PhoneItem[] {
  const L = (h: string, e: string) => (he ? h : e);
  const out: PhoneItem[] = [];
  const n = (t: string) => `\u2066${t}\u2069`;
  if (p.storageFree !== undefined && p.storageTotal) {
    const pct = p.storageFree / p.storageTotal;
    if (p.storageFree < 2 * GB || pct < 0.05) out.push({ level: "bad", title: L(`בטלפון נשארו רק ${n(`${gb(p.storageFree)} GB`)}`, `Only ${gb(p.storageFree)} GB left on the phone`), fix: L("הגדרות הטלפון ← אחסון: אפליקציות גדולות, תמונות וסרטונים כפולים, וקבצים שהורדו.", "Phone settings → Storage: big apps, duplicate photos and videos, downloaded files.") });
    else if (p.storageFree < 8 * GB || pct < 0.1) out.push({ level: "warn", title: L(`בטלפון נשארו ${n(`${gb(p.storageFree)} GB`)}`, `${gb(p.storageFree)} GB left on the phone`), fix: L("כדאי לפנות מקום לפני הורדת מודל לטלפון.", "Worth clearing space before downloading a model to the phone.") });
  }
  if ((p.modelsBytes ?? 0) > 3 * GB) out.push({ level: "warn", title: L(`מודלים בטלפון תופסים ${n(`${gb(p.modelsBytes!)} GB`)}`, `Models on the phone take ${gb(p.modelsBytes!)} GB`), fix: L("בעמוד המודלים של הטלפון: מחקו מודל שלא משתמשים בו.", "On the phone's models page: delete one you do not use.") });
  if ((p.batteryTempC ?? 0) >= 42) out.push({ level: "bad", title: L(`הסוללה חמה: ${n(`${p.batteryTempC}°C`)}`, `The battery is hot: ${p.batteryTempC}°C`), fix: L("עצרו מודל מקומי או משחק, הורידו כיסוי, ואל תטעינו בחום.", "Stop a local model or game, take off the case, and do not charge it hot.") });
  if (p.batteryHealth && p.batteryHealth !== "good" && p.batteryHealth !== "unknown") out.push({ level: "warn", title: L("מצב הסוללה לא תקין", "The battery's health is not good"), fix: L("כדאי לבדוק במעבדה מורשית.", "Worth checking at an authorised service.") });
  if (p.lowMemory) out.push({ level: "warn", title: L("הזיכרון בטלפון כמעט מלא", "The phone's memory is almost full"), fix: L("סגרו אפליקציות שרצות ברקע.", "Close apps running in the background.") });
  // The battery's wear and age (as Samsung's Device Care, Pixel's battery health and AccuBattery show them).
  const wear = batteryWear(p);
  if (wear !== undefined && wear < 80) out.push({ level: "bad", title: L(`הסוללה מחזיקה כ-${n(`${wear}%`)} מהקיבולת המקורית`, `The battery holds about ${wear}% of its original capacity`), fix: L("זה הזמן להחלפת סוללה במעבדה מורשית (בדרך כלל מתחת ל-80% הזמן בין טעינות מתקצר מאוד).", "Time for a battery replacement at an authorised service (below 80% the time between charges drops a lot).") });
  else if (wear !== undefined && wear < 88) out.push({ level: "warn", title: L(`הסוללה מחזיקה כ-${n(`${wear}%`)} מהקיבולת המקורית`, `The battery holds about ${wear}% of its original capacity`), fix: L("כדי להאט את הבלאי: טעינה עד 80–85% (הגדרות ← סוללה ← הגנה על הסוללה), ובלי חום בזמן טעינה.", "To slow the wear: charge to 80–85% (Settings → Battery → battery protection), and no heat while charging.") });
  if ((p.batteryCycles ?? 0) >= 800) out.push({ level: "warn", title: L(`${n(String(p.batteryCycles))} מחזורי טעינה`, `${p.batteryCycles} charge cycles`), fix: L("רוב סוללות הטלפונים מתוכננות ל-800–1000 מחזורים עד 80%: כדאי לשים לב לזמן הסוללה.", "Most phone batteries are rated for 800–1000 cycles to 80%: keep an eye on the battery time.") });
  if (p.charging && (p.batteryPercent ?? 0) >= 95 && (p.batteryTempC ?? 0) >= 38) out.push({ level: "warn", title: L("טעינה מלאה בחום", "Fully charged while warm"), fix: L("חום ליד 100% שוחק את הסוללה הכי מהר: נתקו בסביבות 80–90%, או הפעילו טעינה מותאמת.", "Heat near 100% wears the battery fastest: unplug around 80–90%, or turn on adaptive charging.") });
  if ((p.thermal ?? 0) >= 3) out.push({ level: "bad", title: L("הטלפון חם מאוד ומאט את עצמו", "The phone is very hot and slowing itself down"), fix: L("סגרו משחק או מודל מקומי, הוציאו מהכיסוי והרחיקו מהשמש עד שיתקרר.", "Close a game or local model, take it out of the case and out of the sun until it cools.") });
  else if (p.thermal === 2) out.push({ level: "warn", title: L("הטלפון חם", "The phone is warm"), fix: L("אם זה בזמן משחק זה צפוי; אחרת בדקו איזו אפליקציה עובדת ברקע (הגדרות ← סוללה).", "Expected in a game; otherwise check what runs in the background (Settings → Battery).") });
  if ((p.uptimeHours ?? 0) >= 24 * 7) out.push({ level: "warn", title: L(`הטלפון לא הופעל מחדש ${n(String(Math.floor(p.uptimeHours! / 24)))} ימים`, `The phone has not restarted in ${Math.floor(p.uptimeHours! / 24)} days`), fix: L("הפעלה מחדש פעם בשבוע משחררת זיכרון ומתקנת האטות קטנות.", "A restart once a week frees memory and clears small slowdowns.") });
  const patchAge = patchAgeDays(p.securityPatch, now);
  if (patchAge !== undefined && patchAge > 180) out.push({ level: "bad", title: L(`עדכון האבטחה של הטלפון בן ${n(String(Math.floor(patchAge / 30)))} חודשים`, `The phone's security update is ${Math.floor(patchAge / 30)} months old`), fix: L("הגדרות ← מערכת ← עדכון תוכנה. אם אין עדכונים, היצרן הפסיק לתמוך בטלפון: שימו לב לאפליקציות בנק וסיסמאות.", "Settings → System → Software update. If there are none, the maker stopped supporting the phone: take care with banking apps and passwords.") });
  else if (patchAge !== undefined && patchAge > 90) out.push({ level: "warn", title: L("עדכון האבטחה של הטלפון ישן", "The phone's security update is old"), fix: L("הגדרות ← מערכת ← עדכון תוכנה.", "Settings → System → Software update.") });
  if (!out.length) out.push({ level: "ok", title: L("הטלפון נראה תקין", "The phone looks fine"), fix: L("אין מה לעשות כרגע.", "Nothing to do right now.") });
  return out;
}

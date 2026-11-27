/**
 * "Why does it not connect": turns what the phone (or another computer) found out when the PC did not answer into
 * one plain reason with its fix, the buttons to offer, and whether to try turning Tailscale on by itself. Also the
 * phone's small diagnostics log (the last 50 attempts, read by the PC when they reconnect) and the "Connect
 * Tailscale" call around the Android plugin. Pure functions with the native call injected, so the phone app, the
 * hub page and the desktop interface explain a lost link the same way (research: RESEARCH_LOG 2026-11-27).
 */

/** How the PC looks on the hub: unknown when the hub could not be asked. */
export type PcOnHub = "online" | "asleep" | "offline" | "restarting";

/** What was found out, each part optional (undefined means "not checked"). */
export interface ConnectFacts {
  /** The device reached the internet at all (the hub, or a known always-up address). */
  internet?: boolean;
  /** The hub answered. */
  hub?: boolean;
  /** How the hub sees the PC. */
  pcOnHub?: PcOnHub;
  /** The version the PC said it is restarting into (when `pcOnHub` is "restarting"). */
  pcUpdate?: string;
  /** When the hub last heard from the PC (ISO). */
  pcLastSeen?: string;
  /** The saved addresses: one answered, none answered, or the PC answered but refused this device's key. */
  direct?: "ok" | "fail" | "unauthorized";
  /** The PC told this device a Tailscale address (the direct path outside home). */
  hasTailscalePath?: boolean;
  /** The PC left a new address that differs from the saved ones (link-beacon). */
  addressChanged?: boolean;
  /** This device can send a Wake-on-LAN packet to the PC (the phone at home, with the PC's network card known). */
  canWake?: boolean;
}

/** The reason, one per case. */
export type ConnectReason =
  | "connected"
  | "no-internet"
  | "pairing-expired"
  | "pc-restarting"
  | "pc-asleep"
  | "pc-offline"
  | "address-changed"
  | "tailscale-off"
  | "no-route"
  | "unknown";

/** A button the sheet offers: turn Tailscale on, open the PC through the hub, wake the PC, try again. */
export type ConnectAction = "tailscale" | "hub" | "wake" | "retry";

/** A text in Hebrew and English. */
export interface Words {
  he: string;
  en: string;
}

/** The verdict: the reason, what it means and what to do, and the buttons (most useful first). */
export interface ConnectVerdict {
  reason: ConnectReason;
  title: Words;
  fix: Words;
  actions: ConnectAction[];
}

/** One check in the sheet, ✓ / ✕ / — with the time it was made. */
export interface ConnectCheck {
  id: "internet" | "hub" | "pc" | "direct" | "tailscale";
  state: "ok" | "fail" | "unknown";
  /** When it was checked (ms). */
  at: number;
}

/** The names of the checks in the sheet. */
export const CHECK_LABELS: Record<ConnectCheck["id"], Words> = {
  internet: { he: "אינטרנט במכשיר הזה", en: "Internet on this device" },
  hub: { he: "ההאב עונה", en: "The hub answers" },
  pc: { he: "המחשב מחובר להאב", en: "The PC is online on the hub" },
  direct: { he: "חיבור ישיר למחשב", en: "Direct link to the PC" },
  tailscale: { he: "כתובת Tailscale של המחשב", en: "The PC's Tailscale address" },
};

const VERDICTS: Record<ConnectReason, { title: Words; fix: Words }> = {
  connected: { title: { he: "מחובר", en: "Connected" }, fix: { he: "", en: "" } },
  "no-internet": {
    title: { he: "אין אינטרנט במכשיר הזה", en: "No internet on this device" },
    fix: { he: "התחבר ל-Wi-Fi או לנתונים ונסה שוב.", en: "Connect to Wi-Fi or mobile data and try again." },
  },
  "pairing-expired": {
    title: { he: "המחשב לא מכיר את המכשיר הזה יותר", en: "The PC no longer knows this device" },
    fix: { he: "החיבור בוטל או פג. במחשב: הגדרות ← טלפון, וסרוק שוב את קוד ה-QR.", en: "The pairing was removed or expired. On the PC: Settings → Phone, and scan the QR code again." },
  },
  "pc-restarting": {
    title: { he: "המחשב מופעל מחדש לעדכון", en: "The PC is restarting for an update" },
    fix: { he: "זה לוקח בדרך כלל דקה-שתיים. ננסה שוב לבד; בינתיים אפשר לעבוד דרך ההאב.", en: "This usually takes a minute or two. It tries again by itself; meanwhile you can work through the hub." },
  },
  "pc-asleep": {
    title: { he: "המחשב בשינה", en: "The PC is asleep" },
    fix: { he: "הער אותו (בבית, ב-Wake-on-LAN) או שלח משימות דרך ההאב; הן יחכו לו.", en: "Wake it (at home, with Wake-on-LAN) or send tasks through the hub; they wait for it." },
  },
  "pc-offline": {
    title: { he: "המחשב לא מחובר", en: "The PC is offline" },
    fix: { he: "הוא כבוי, בשינה, KesherAI סגור, או שאין לו אינטרנט. כשהוא חוזר, החיבור חוזר לבד.", en: "It is off, asleep, KesherAI is closed, or it has no internet. When it is back, the link comes back by itself." },
  },
  "address-changed": {
    title: { he: "הכתובת של המחשב השתנתה", en: "The PC's address changed" },
    fix: { he: "נמצאה כתובת חדשה ונבדקה. אם זה לא עבד, סרוק שוב את הקוד מהגדרות ← טלפון.", en: "A new address was found and tried. If it did not work, scan the code again from Settings → Phone." },
  },
  "tailscale-off": {
    title: { he: "Tailscale בטלפון כבוי", en: "Tailscale on this phone is off" },
    fix: { he: "המחשב מחובר, אבל הקישור הישיר עובר דרך Tailscale. הדלק את Tailscale בטלפון (הכפתור למטה) או עבוד דרך ההאב.", en: "The PC is online, but the direct link goes through Tailscale. Turn Tailscale on (the button below) or work through the hub." },
  },
  "no-route": {
    title: { he: "אין דרך ישירה למחשב מכאן", en: "No direct way to the PC from here" },
    fix: { he: "מחוץ לבית צריך Tailscale בטלפון ובמחשב (אותו חשבון), או לעבוד דרך ההאב.", en: "Away from home you need Tailscale on the phone and the PC (same account), or work through the hub." },
  },
  unknown: {
    title: { he: "המחשב לא עונה", en: "The PC does not answer" },
    fix: { he: "או שהמחשב כבוי / בשינה / מתעדכן, או ש-Tailscale בטלפון כבוי. הדלק את Tailscale או בדוק בהאב.", en: "Either the PC is off, asleep or updating, or Tailscale on this phone is off. Turn Tailscale on, or check on the hub." },
  },
};

/**
 * Chooses the one reason the PC cannot be reached, from the checks: the device's own internet first, then a refused
 * key, then what the hub says about the PC, then the direct path (a changed address, Tailscale off, no route).
 *
 * @param f - What was found out.
 * @returns The reason, its words in Hebrew and English, and the buttons to offer.
 */
export function diagnoseConnection(f: ConnectFacts): ConnectVerdict {
  const verdict = (reason: ConnectReason, actions: ConnectAction[]): ConnectVerdict => {
    const v = VERDICTS[reason];
    const title = reason === "pc-restarting" && f.pcUpdate ? { he: `${v.title.he} (${f.pcUpdate})`, en: `${v.title.en} (${f.pcUpdate})` } : v.title;
    // Wake only where a packet can be sent; Tailscale only where the PC has a Tailscale address.
    const ok = actions.filter((a) => (a !== "wake" || f.canWake) && (a !== "tailscale" || f.hasTailscalePath));
    return { reason, title, fix: v.fix, actions: ok };
  };
  if (f.direct === "ok") return verdict("connected", []);
  if (f.internet === false) return verdict("no-internet", ["retry"]);
  if (f.direct === "unauthorized") return verdict("pairing-expired", ["hub"]);
  if (f.pcOnHub === "restarting") return verdict("pc-restarting", ["retry", "hub"]);
  if (f.pcOnHub === "asleep") return verdict("pc-asleep", ["wake", "hub", "retry"]);
  if (f.pcOnHub === "offline") return verdict("pc-offline", ["wake", "hub", "retry"]);
  if (f.addressChanged) return verdict("address-changed", ["retry", "hub"]);
  if (f.pcOnHub === "online") return verdict(f.hasTailscalePath ? "tailscale-off" : "no-route", ["tailscale", "hub", "retry"]);
  return verdict(f.hasTailscalePath ? "unknown" : "no-route", ["tailscale", "hub", "wake", "retry"]);
}

/**
 * The checks for the sheet, each ✓ / ✕ / — and stamped with the time.
 *
 * @param f - What was found out.
 * @param at - When (ms).
 * @returns The rows, in the order they are shown.
 */
export function connectChecks(f: ConnectFacts, at: number): ConnectCheck[] {
  const s = (v: boolean | undefined): ConnectCheck["state"] => (v === undefined ? "unknown" : v ? "ok" : "fail");
  return [
    { id: "internet", state: s(f.internet), at },
    { id: "hub", state: s(f.hub), at },
    { id: "pc", state: f.pcOnHub === undefined ? "unknown" : f.pcOnHub === "online" ? "ok" : "fail", at },
    { id: "direct", state: f.direct === undefined ? "unknown" : f.direct === "ok" ? "ok" : "fail", at },
    { id: "tailscale", state: s(f.hasTailscalePath), at },
  ];
}

/**
 * Whether to try turning Tailscale on by itself: the direct link failed, the device has internet, the PC has a
 * Tailscale address, the PC is not known to be away, the device is not on the home network (there the home address
 * is the way), and it was not tried in the last 10 minutes (so it never loops).
 *
 * @param f - What was found out.
 * @param o - Whether this device is on the PC's home network, and when it was last tried (ms).
 * @param now - Now (ms).
 * @returns True to send the Tailscale "connect" by itself.
 */
export function shouldAutoTailscale(f: ConnectFacts, o: { atHome?: boolean; lastTried?: number }, now: number): boolean {
  if (f.direct !== "fail" || f.internet === false || !f.hasTailscalePath || o.atHome) return false;
  if (f.pcOnHub && f.pcOnHub !== "online") return false;
  return !o.lastTried || now - o.lastTried > 10 * 60_000;
}

/** The Android plugin's two calls (apps/android/plugins/tailscale): Tailscale's own broadcast, and opening its app. */
export interface TailscalePlugin {
  connect(): Promise<unknown>;
  open(): Promise<unknown>;
}

/** What "Connect Tailscale" did: sent Tailscale's broadcast, opened its app, or neither; and whether the PC answers now. */
export interface TailscaleResult {
  how: "broadcast" | "opened" | "none";
  reachable: boolean;
  error?: string;
}

/**
 * Turns Tailscale on: sends the Tailscale app's CONNECT_VPN broadcast through the plugin; when that cannot be sent,
 * opens the Tailscale app instead (she taps Connect there). Then checks a few times whether the PC answers.
 *
 * @param d - The plugin (missing outside the Android app), the check that the PC answers, how to wait, how many checks.
 * @returns What was done and whether the PC answers now.
 */
export async function connectTailscale(d: { plugin?: TailscalePlugin; probe: () => Promise<boolean>; wait?: (ms: number) => Promise<void>; tries?: number; gapMs?: number }): Promise<TailscaleResult> {
  const wait = d.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let how: TailscaleResult["how"] = "none";
  let error: string | undefined;
  if (d.plugin) {
    try {
      await d.plugin.connect();
      how = "broadcast";
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      try {
        await d.plugin.open();
        how = "opened";
      } catch (e2) {
        error = e2 instanceof Error ? e2.message : String(e2);
      }
    }
  }
  const tries = Math.max(1, d.tries ?? 8);
  for (let i = 0; i < tries; i++) {
    // Tailscale needs a few seconds to bring the tunnel up (longer when she has to tap Connect in its app).
    if (how !== "none" || i > 0) await wait(d.gapMs ?? 2500);
    if (await d.probe().catch(() => false)) return { how, reachable: true, ...(error && how === "opened" ? { error } : {}) };
  }
  return { how, reachable: false, ...(error ? { error } : {}) };
}

/** One connection attempt in the phone's diagnostics log. */
export interface ConnectAttempt {
  /** When (ms). */
  at: number;
  /** Which address kind: the home network, Tailscale, the "anywhere" link, the hub, or a new address from the beacon. */
  via: "home" | "tailscale" | "anywhere" | "hub" | "beacon";
  ok: boolean;
  /** The HTTP status when one came back. */
  status?: number;
  /** The reason the sheet showed. */
  reason?: ConnectReason;
}

/** The most attempts kept. */
export const ATTEMPTS_MAX = 50;

const VIAS = new Set<ConnectAttempt["via"]>(["home", "tailscale", "anywhere", "hub", "beacon"]);
const REASONS = new Set<ConnectReason>(Object.keys(VERDICTS) as ConnectReason[]);

/**
 * Reads a log from untrusted input (storage, a request body): known fields only, the last 50.
 *
 * @param raw - The input.
 * @returns The clean attempts, oldest first.
 */
export function cleanAttempts(raw: unknown): ConnectAttempt[] {
  if (!Array.isArray(raw)) return [];
  const out: ConnectAttempt[] = [];
  for (const x of raw.slice(-ATTEMPTS_MAX)) {
    if (!x || typeof x !== "object") continue;
    const a = x as Record<string, unknown>;
    if (typeof a.at !== "number" || !Number.isFinite(a.at) || !VIAS.has(a.via as ConnectAttempt["via"])) continue;
    out.push({
      at: Math.floor(a.at),
      via: a.via as ConnectAttempt["via"],
      ok: a.ok === true,
      ...(typeof a.status === "number" && a.status >= 100 && a.status < 600 ? { status: Math.floor(a.status) } : {}),
      ...(REASONS.has(a.reason as ConnectReason) ? { reason: a.reason as ConnectReason } : {}),
    });
  }
  return out;
}

/**
 * Adds an attempt and keeps the last 50.
 *
 * @param list - The log so far.
 * @param a - The new attempt.
 * @returns A new log.
 */
export function addAttempt(list: ConnectAttempt[], a: ConnectAttempt): ConnectAttempt[] {
  return [...list, a].slice(-ATTEMPTS_MAX);
}

/**
 * The log as short lines for the PC's fault log (no addresses or keys: only kind, result and reason).
 *
 * @param list - The attempts.
 * @returns One line per attempt.
 */
export function attemptLines(list: ConnectAttempt[]): string[] {
  return list.map((a) => `${new Date(a.at).toISOString().slice(0, 19)}Z ${a.via} ${a.ok ? "ok" : "fail"}${a.status ? ` ${a.status}` : ""}${a.reason ? ` ${a.reason}` : ""}`);
}

/**
 * Approvals from the phone's notification (the design doc's PhoneAskNotify boards): what the hub page's service worker
 * (`public/sw.js`) shows for a Web Push and does when a button is tapped, with the page closed.
 *
 * - The push carries the waiting count in clear and, from a current PC, a small `ask_note` sealed by the PC to this
 *   browser's device key (the newest ask: kind, short title, request id, expiry). The hub copies it in unread. The
 *   service worker opens it with the device's private key from IndexedDB (non-extractable) and the PC's public key the
 *   page kept from presence (`pcKeys`), and shows the ask with two buttons: Run / Not now (an Antigravity Run ask) or
 *   Approve / Deny (any other approval). Anything it cannot open falls back to the count ("2 waiting for you").
 * - A button seals an `approval_answer` from this device to that PC (the same message as the page's own buttons) and
 *   posts it to the hub's `/api/answer`; the PC checks the device and applies it once (answerRun for a Run ask).
 *   Refused here after the ask's expiry, and an ask answered from a notification is never answered again from one.
 * - A plain tap opens the hub at that ask's card (`/#waiting=<requestId>`).
 *
 * No DOM: this runs in the service worker (compiled with the page, imported by `sw.js` as a module).
 */
import { openEnvelope, sealMessage, type HubCryptoKey } from "../../../packages/shared/src/hub-crypto.js";
import { parseEnvelope, type HubAskNote, type SealedEnvelope } from "../../../packages/shared/src/hub-protocol.js";
import type { PcKeys } from "./kv.js";

/** The service worker's language (the hub sends the page's language with each push). */
export type AskLang = "he" | "en";

/** A Web Push from the hub, checked. */
export interface PushPayload {
  title: string;
  body: string;
  tag: string;
  url: string;
  lang: AskLang;
  /** The PC's sealed `ask_note` for this browser, when the PC sent one. */
  note?: SealedEnvelope;
}

/** What a notification keeps for its tap: where a plain tap goes, and the ask a button answers. */
export interface AskData {
  url: string;
  lang: AskLang;
  ask?: HubAskNote & { pc: string; pcName: string };
}

/** A notification to show: its title and `showNotification` options. */
export interface Shown {
  title: string;
  options: {
    body: string;
    tag: string;
    renotify: boolean;
    silent?: boolean;
    icon: string;
    dir: "rtl" | "ltr";
    lang: AskLang;
    actions?: Array<{ action: "allow" | "deny"; title: string }>;
    data: AskData;
  };
}

/** What the service worker needs from its world (tests pass their own). */
export interface AskIo {
  /** Reads a value of the page's IndexedDB (kv.ts `get`). */
  get: <T>(key: string) => Promise<T | undefined>;
  /** Writes a value of the page's IndexedDB (kv.ts `put`). */
  put: (key: string, value: unknown) => Promise<void>;
  fetch: typeof fetch;
  now: () => number;
}

/** How a button's answer went. */
export type AnswerResult = "sent" | "expired" | "answered" | "failed";

/** This browser's identity as the page keeps it (kv `device`), the parts used here. */
interface StoredIdentity {
  deviceId: string;
  token: string;
  privateKey: HubCryptoKey;
}

/** The notification's tag (the page closes it by this tag when it comes to the front; the same as the Worker's). */
const TAG = "kesher-waiting";
/** Asks answered from a notification that are remembered (newest last). */
const ANSWERED_KEEP = 50;

const WORDS = {
  he: {
    run: "✦ להריץ ב-Antigravity?",
    tool: "💬 מחכה לאישור שלך",
    runYes: "▶ הפעל",
    runNo: "לא עכשיו",
    toolYes: "✓ אשר",
    toolNo: "דחה",
    until: (t: string) => `עד ${t}`,
    more: (n: number) => `ועוד ${n} מחכים`,
    expired: "⌛ הבקשה פגה",
    expiredBody: "פתחו את KesherAI כדי לבקש שוב",
    sent: "✓ נשלח למחשב",
    answered: "✓ כבר נענה",
    failed: "לא נשלח",
    failedBody: "הקישו כדי לפתוח את KesherAI ולענות משם",
  },
  en: {
    run: "✦ Run in Antigravity?",
    tool: "💬 Waiting for your approval",
    runYes: "▶ Run",
    runNo: "Not now",
    toolYes: "✓ Approve",
    toolNo: "Deny",
    until: (t: string) => `until ${t}`,
    more: (n: number) => `${n} more waiting`,
    expired: "⌛ This ask expired",
    expiredBody: "Open KesherAI to ask again",
    sent: "✓ Sent to the PC",
    answered: "✓ Already answered",
    failed: "Not sent",
    failedBody: "Tap to open KesherAI and answer there",
  },
} as const;

/**
 * Only a path on this hub is ever opened (a tap must never leave the hub).
 *
 * @param u - The path from the push or the notification.
 * @returns The path, or "Waiting for you".
 */
export function samePath(u: unknown): string {
  return typeof u === "string" && /^\/[^/\\]/.test(u) ? u : "/#waiting";
}

/**
 * Reads a push from the hub (untrusted shape): text capped, the path kept on this hub, the note checked.
 *
 * @param x - The push's JSON.
 * @returns The payload.
 */
export function readPayload(x: unknown): PushPayload {
  const d = x && typeof x === "object" ? (x as Record<string, unknown>) : {};
  const note = parseEnvelope(d.note);
  return {
    title: typeof d.title === "string" ? d.title.slice(0, 80) : "KesherAI",
    body: typeof d.body === "string" ? d.body.slice(0, 200) : "",
    tag: typeof d.tag === "string" && /^[\w-]{1,40}$/.test(d.tag) ? d.tag : TAG,
    url: samePath(d.url),
    lang: d.lang === "he" ? "he" : "en",
    ...(note && note.kind === "ask_note" ? { note } : {}),
  };
}

/** The base options of every notification here. */
function base(lang: AskLang, body: string, data: AskData, renotify = true): Shown["options"] {
  return { body, tag: TAG, renotify, icon: "/icon-192.png", dir: lang === "he" ? "rtl" : "ltr", lang, data };
}

/**
 * The count-only notification ("KesherAI: 2 waiting for you"), as before notes.
 *
 * @param p - The push.
 * @returns What to show.
 */
export function countNotification(p: PushPayload): Shown {
  return { title: p.title, options: { ...base(p.lang, p.body, { url: p.url, lang: p.lang }), tag: p.tag } };
}

/** Where a plain tap on an ask goes: the hub at that ask's card. */
export function askUrl(requestId: string): string {
  return `/#waiting=${encodeURIComponent(requestId)}`;
}

/**
 * The ask with its two buttons, or the expired notification when its time is over.
 *
 * @param lang - The language.
 * @param ask - The opened ask.
 * @param pc - The PC that asks (its id and name).
 * @param waiting - How many wait on that PC in all.
 * @param now - The time now (ms).
 * @returns What to show.
 */
export function askNotification(lang: AskLang, ask: HubAskNote, pc: { id: string; name: string }, waiting: number, now: number): Shown {
  const w = WORDS[lang];
  const data: AskData = { url: askUrl(ask.requestId), lang, ask: { ...ask, pc: pc.id, pcName: pc.name } };
  if (now >= ask.until) return expiredNotification(data);
  const time = new Date(ask.until).toLocaleTimeString(lang === "he" ? "he-IL" : "en-GB", { hour: "2-digit", minute: "2-digit" });
  const line = [`🖥 ${pc.name}`, w.until(time), waiting > 1 ? w.more(waiting - 1) : ""].filter(Boolean).join(" · ");
  const run = ask.kind === "run";
  return {
    title: run ? w.run : w.tool,
    options: {
      ...base(lang, `${ask.title}\n${line}`, data),
      actions: [
        { action: "allow", title: run ? w.runYes : w.toolYes },
        { action: "deny", title: run ? w.runNo : w.toolNo },
      ],
    },
  };
}

/**
 * "This ask expired" (no buttons; a tap opens the hub).
 *
 * @param data - The ask's notification data.
 * @returns What to show.
 */
export function expiredNotification(data: AskData): Shown {
  const w = WORDS[data.lang];
  return { title: w.expired, options: base(data.lang, [data.ask?.title, w.expiredBody].filter(Boolean).join("\n"), { url: data.url, lang: data.lang }, false) };
}

/**
 * What a button's answer shows afterwards: sent (quiet), already answered, expired, or not sent (a tap opens the hub).
 *
 * @param data - The ask's notification data.
 * @param decision - The button.
 * @param result - How it went.
 * @returns What to show.
 */
export function resultNotification(data: AskData, decision: "allow" | "deny", result: AnswerResult): Shown {
  const w = WORDS[data.lang];
  if (result === "expired") return expiredNotification(data);
  const run = data.ask?.kind === "run";
  const said = decision === "allow" ? (run ? w.runYes : w.toolYes) : run ? w.runNo : w.toolNo;
  const what = data.ask?.title ?? "";
  if (result === "failed") return { title: w.failed, options: base(data.lang, [what, w.failedBody].filter(Boolean).join("\n"), { url: data.url, lang: data.lang }) };
  const title = result === "sent" ? w.sent : w.answered;
  return { title, options: { ...base(data.lang, [said, what].filter(Boolean).join(" · "), { url: "/#waiting", lang: data.lang }, false), silent: true } };
}

/**
 * Turns a push into the notification to show: the ask with buttons when the PC's note opens with this device's key and
 * that PC's key, else the count.
 *
 * @param raw - The push's JSON.
 * @param io - IndexedDB, fetch and the clock.
 * @returns What to show.
 */
export async function notificationForPush(raw: unknown, io: AskIo): Promise<Shown> {
  const p = readPayload(raw);
  if (!p.note) return countNotification(p);
  try {
    const id = await io.get<StoredIdentity>("device");
    const pc = (await io.get<PcKeys>("pcKeys"))?.[p.note.from];
    if (!id?.privateKey || !pc || p.note.to !== id.deviceId) return countNotification(p);
    const body = await openEnvelope(p.note, id.privateKey, pc.publicKey);
    if (body.type !== "ask_note") return countNotification(p);
    if (((await io.get<string[]>("answered")) ?? []).includes(body.ask.requestId)) return countNotification(p);
    return askNotification(p.lang, body.ask, { id: p.note.from, name: pc.name }, body.waiting, io.now());
  } catch {
    return countNotification(p);
  }
}

/**
 * A button on an ask: seals the answer from this device to the PC and posts it to the hub, once, before the ask ends.
 *
 * @param data - The notification's data (the ask, from the opened note).
 * @param decision - Allow (Run / Approve) or deny (Not now / Deny).
 * @param io - IndexedDB, fetch and the clock.
 * @returns How it went.
 */
export async function answerAsk(data: AskData, decision: "allow" | "deny", io: AskIo): Promise<AnswerResult> {
  const ask = data.ask;
  if (!ask) return "failed";
  if (io.now() >= ask.until) return "expired";
  try {
    const answered = (await io.get<string[]>("answered")) ?? [];
    if (answered.includes(ask.requestId)) return "answered";
    const id = await io.get<StoredIdentity>("device");
    const pc = (await io.get<PcKeys>("pcKeys"))?.[ask.pc];
    if (!id?.privateKey || !pc) return "failed";
    const env = await sealMessage({ from: id.deviceId, to: ask.pc, kind: "approval_answer" }, { type: "approval_answer", requestId: ask.requestId, conversationId: ask.conversationId, decision }, id.privateKey, pc.publicKey);
    const r = await io.fetch("/api/answer", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", authorization: `Bearer ${id.token}` }, body: JSON.stringify({ env }) });
    if (!r.ok) return "failed";
    await io.put("answered", [...answered, ask.requestId].slice(-ANSWERED_KEEP));
    return "sent";
  } catch {
    return "failed";
  }
}

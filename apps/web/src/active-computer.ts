import { awayText, computerState, diagnoseConnection, type AwayNote, type ConnectVerdict } from "@kesher/shared";

/**
 * The computer the whole app works with, one choice for every chat (not one per chat). "" means the computer this
 * page is served from. A chat can still pick another computer for itself in its model menu; that choice wins, and
 * this one is only where a chat starts.
 */
const KEY = "kesherai-active-computer";

/** Sent on `window` when the app-wide computer changes, so open chats and menus update at once. */
export const ACTIVE_COMPUTER_EVENT = "kesher-active-computer";

/** @returns The chosen computer's provider id (`device-…`), or "" for the connected one. */
export function activeComputer(): string {
  try {
    const v = localStorage.getItem(KEY) ?? "";
    return /^device-[\w-]{1,80}$/.test(v) ? v : "";
  } catch {
    return "";
  }
}

/**
 * Chooses the computer for every chat.
 *
 * @param providerId - A `device-…` provider id, or "" for the connected computer.
 */
export function setActiveComputer(providerId: string): void {
  try {
    if (providerId) localStorage.setItem(KEY, providerId);
    else localStorage.removeItem(KEY);
  } catch {
    // storage off: the choice lasts until the page closes only through the event
  }
  if (typeof dispatchEvent === "function") dispatchEvent(new Event(ACTIVE_COMPUTER_EVENT));
}

/**
 * Which computer a chat's model menu starts on: the chat's own (its model runs on a device) first, then the
 * app-wide one when it is still among the computers found, then the connected one.
 *
 * @param chatDevice - The device the chat's model runs on ("" when none).
 * @param active - The app-wide choice.
 * @param found - Provider ids of the computers found now.
 */
export function startComputer(chatDevice: string, active: string, found: string[]): string {
  if (chatDevice) return chatDevice;
  return active && found.includes(active) ? active : "";
}

/** A computer in the Computers menu. */
export interface ComputerRow {
  id: string;
  name: string;
  me: boolean;
  online: boolean;
  lastSeen?: string;
  version?: string;
  providerId?: string;
  asleepSince?: string;
  asleepNote?: AwayNote;
}

/**
 * The status line under a computer's name: which one it is, online / asleep / offline (asleep says when and what
 * was running, offline says when it was last seen), its version, and whether it is in use.
 *
 * @param r - The computer.
 * @param inUse - Whether every chat starts on it.
 * @param now - Now (ms), for tests.
 * @param he - Hebrew (true) or English.
 */
export function computerLine(r: ComputerRow, inUse: boolean, now: number, he: boolean): string {
  const state = computerState(r);
  const status = state === "online" ? (he ? "זמין" : "Online") : state === "asleep" ? awayText({ at: r.asleepSince, note: r.asleepNote }, now, he) : [he ? "לא זמין" : "Offline", lastSeenText(r.lastSeen, now, he)].filter(Boolean).join(" · ");
  return [r.me ? (he ? "המחשב המחובר" : "Connected computer") : "", status, r.version ? `v${r.version}` : "", inUse ? (he ? "בשימוש בכל הצ'אטים" : "Used for all chats") : ""].filter(Boolean).join(" · ");
}

/**
 * Why another computer cannot be used now (connect-why.ts, the same reasons the phone app shows): restarting for an
 * update, asleep, or offline, with what to do. Null for one that is online, and for the connected one.
 *
 * @param r - The computer.
 */
export function computerWhy(r: ComputerRow): ConnectVerdict | null {
  if (r.me || r.online) return null;
  const pcOnHub = r.asleepNote?.update ? "restarting" : computerState(r) === "asleep" ? "asleep" : "offline";
  return diagnoseConnection({ internet: true, pcOnHub, ...(r.asleepNote?.update ? { pcUpdate: r.asleepNote.update } : {}) });
}

/**
 * Orders the list for the menu: the computer in use first, then those online, then the rest by name.
 *
 * @param rows - The computers found.
 * @param active - The app-wide choice ("" is the connected computer, shown as `me`).
 */
export function sortComputers(rows: ComputerRow[], active: string): ComputerRow[] {
  const inUse = (r: ComputerRow) => (active ? r.providerId === active : r.me);
  return [...rows].sort((a, b) => Number(inUse(b)) - Number(inUse(a)) || Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));
}

/**
 * "Last seen" for a computer that does not answer: minutes, hours or days ago.
 *
 * @param iso - When it was last seen.
 * @param now - Now (ms), for tests.
 * @param he - Hebrew (true) or English.
 * @returns A short phrase, or "" when the time is unknown.
 */
export function lastSeenText(iso: string | undefined, now: number, he: boolean): string {
  const at = iso ? Date.parse(iso) : NaN;
  if (Number.isNaN(at)) return "";
  const min = Math.max(0, Math.round((now - at) / 60_000));
  if (min < 2) return he ? "נראה עכשיו" : "seen just now";
  if (min < 60) return he ? `נראה לפני ${min} דקות` : `seen ${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 48) return he ? `נראה לפני ${h} שעות` : `seen ${h} h ago`;
  const d = Math.round(h / 24);
  return he ? `נראה לפני ${d} ימים` : `seen ${d} days ago`;
}

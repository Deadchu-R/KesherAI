import type { BrowserAction } from "./browser-safety.js";
import type { ComputerAction } from "./computer.js";

/**
 * The phone's live view of browser and computer control (docs/research/browser-computer-control.md Phase 7): one
 * merged action log for the browser and the computer, "what it is doing now", and who is watching a chat — so a
 * browser or computer approval goes to the phone as a notification only when no screen shows it.
 */

/** One line of the merged action log. */
export interface LiveAction {
  at: string;
  kind: "browser" | "computer";
  /** The browser tool (`browser_click`) or the computer action (`click`, `stop`…). */
  action: string;
  /** The site (browser) or the app (computer). */
  where?: string;
  /** What it acted on (browser only: `button "Send"`, an address). */
  target?: string;
  ok: boolean;
  note?: string;
}

/**
 * Merges the browser's and the computer's logs into one, oldest first.
 *
 * @param browser - The browser tools' last actions.
 * @param computer - The computer's last actions.
 * @param n - How many to keep (the newest).
 * @returns The merged log.
 */
export function mergeControlLog(browser: BrowserAction[], computer: ComputerAction[], n = 40): LiveAction[] {
  const all: LiveAction[] = [
    ...browser.map((a): LiveAction => ({ at: a.at, kind: "browser", action: a.tool, ...(a.site ? { where: a.site } : {}), ...(a.target ? { target: a.target } : {}), ok: a.ok, ...(a.note ? { note: a.note } : {}) })),
    ...computer.map((a): LiveAction => ({ at: a.at, kind: "computer", action: a.action, ...(a.app ? { where: a.app } : {}), ok: a.ok, ...(a.note ? { note: a.note } : {}) })),
  ];
  // A Stop is logged by both (one Stop ends both): show it once.
  const browserStops = browser.filter((a) => a.tool === "stop").map((a) => Date.parse(a.at));
  const twin = (a: LiveAction) => a.kind === "computer" && a.action === "stop" && browserStops.some((t) => Math.abs(t - Date.parse(a.at)) < 2000);
  return all.filter((a) => !twin(a)).sort((a, b) => a.at.localeCompare(b.at)).slice(-n);
}

/** Tool names that are browser or computer control (their approvals are "control" approvals). */
export function isControlTool(name: string): boolean {
  return /^(browser|computer)_/.test(name);
}

/**
 * How long a browser or computer approval waits before its notification: shorter than other approvals (they count
 * as denied after 5 minutes), but never longer than the user's own "waiting" setting.
 *
 * @param waitingSeconds - The user's "notify after waiting" setting.
 * @returns Seconds.
 */
export function controlNoteDelay(waitingSeconds: number): number {
  return Math.max(0, Math.min(waitingSeconds, 10));
}

/** How long a screen counts as watching after it last said so. */
export const WATCH_MS = 12_000;

/**
 * Which chats a screen shows right now: the phone's live view and a visible browser/computer approval card say so
 * every few seconds (only while their page is on screen).
 */
export class ControlWatchers {
  private readonly seen = new Map<string, number>();

  /**
   * A screen shows these chats now.
   *
   * @param chats - Conversation ids, or "*" for the live view (it shows every chat's approvals).
   * @param now - For tests.
   */
  mark(chats: string[], now = Date.now()): void {
    for (const c of chats.slice(0, 50)) if (/^[\w*-]{1,80}$/.test(c)) this.seen.set(c, now);
    if (this.seen.size > 500) for (const [k, t] of this.seen) if (now - t > WATCH_MS) this.seen.delete(k);
  }

  /**
   * @param chat - A conversation id.
   * @param now - For tests.
   * @returns Whether a screen showed it (or the live view was open) in the last {@link WATCH_MS}.
   */
  watching(chat: string, now = Date.now()): boolean {
    return [chat, "*"].some((k) => {
      const t = this.seen.get(k);
      return t !== undefined && now - t < WATCH_MS;
    });
  }
}

import { deviceKey } from "./api";

/**
 * The Android app's own notifications (the KesherNotify native plugin): the live connection to the
 * computer and UnifiedPush through ntfy. Outside the Android app none of this exists, and every function
 * here does nothing.
 */

/** What the phone reports. */
export interface PhoneNotifyState {
  permission: boolean;
  live: boolean;
  connected: boolean;
  push: boolean;
  pushState: string;
  distributor?: string;
  distributors: number;
}

interface Plugin {
  configure(o: { base: string; key: string; live: boolean; push: boolean }): Promise<PhoneNotifyState>;
  status(): Promise<PhoneNotifyState>;
  clear(o: { id: string }): Promise<void>;
  takeOpen(): Promise<{ path?: string }>;
  openSettings(): Promise<void>;
  addListener(event: "open", cb: (e: { path: string }) => void): unknown;
}

/** @returns The native plugin, inside an Android app new enough to have it. */
export function phoneNotify(): Plugin | undefined {
  return (window as unknown as { Capacitor?: { Plugins?: { KesherNotify?: Plugin } } }).Capacitor?.Plugins?.KesherNotify;
}

/**
 * Turns the phone's own notifications on or off.
 *
 * @param live - Hold a live connection to the computer.
 * @param push - Use UnifiedPush (ntfy) when the computer cannot be reached.
 * @returns What the phone reports, or an error to show.
 */
export async function setPhoneNotify(live: boolean, push: boolean): Promise<PhoneNotifyState> {
  const p = phoneNotify();
  const key = deviceKey();
  if (!p) throw new Error("Update the KesherAI app on the phone to get its own notifications.");
  if (!key) throw new Error("This phone has no key of its own: pair it again in Settings → Phone on the computer.");
  return p.configure({ base: location.origin, key, live, push });
}

/**
 * At start: opens the page a tapped notification asked for, follows later taps, and keeps the
 * phone's address and key current (after switching computers or pairing again).
 */
export function startPhoneNotify(): void {
  const p = phoneNotify();
  if (!p) return;
  const go = (path?: string) => {
    if (path && /^#\/[\w\-/]*$/.test(path)) location.hash = path;
  };
  p.addListener("open", (e) => go(e.path));
  void p.takeOpen().then((r) => go(r.path), () => undefined);
  void p.status().then(
    (s) => {
      if (s.live || s.push) void setPhoneNotify(s.live, s.push).catch(() => undefined);
    },
    () => undefined,
  );
}

/**
 * The chat is open on the phone: its notifications go, as in messaging apps.
 *
 * @param convId - The conversation.
 */
export function clearPhoneNotes(convId: string): void {
  void phoneNotify()?.clear({ id: convId }).catch(() => undefined);
}

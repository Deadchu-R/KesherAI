import { api, deviceKey } from "./api";

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
  /** The user set the switch on the app's home screen (newer apps). */
  chosen?: boolean;
}

interface Plugin {
  configure(o: { base: string; key: string; alt?: string; live: boolean; push: boolean }): Promise<PhoneNotifyState>;
  status(): Promise<PhoneNotifyState>;
  clear(o: { id: string }): Promise<void>;
  takeOpen(): Promise<{ path?: string }>;
  openSettings(): Promise<void>;
  /** Android's permission question (newer apps). */
  askPermission?(): Promise<PhoneNotifyState>;
  /** The app's own switch, without the computer (newer apps). */
  setLive?(o: { live: boolean }): Promise<PhoneNotifyState>;
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
  // The computer's internet link: the live connection uses it away from home (no other app needed).
  const internet = await api<{ internet?: string | null }>("/api/phone-push").then((r) => r.internet ?? "", () => "");
  return p.configure({ base: location.origin, key, alt: internet, live, push });
}

/** Tells the computer how this phone's notifications are set (shown in the computer's settings). */
function hello(info: { plugin: boolean; permission?: boolean; live?: boolean; error?: string }): void {
  if (deviceKey()) void api("/api/phone-push/hello", { method: "POST", body: info }).catch(() => undefined);
}

const ASKED = "kesher.notify.asked";

/**
 * At start, in the Android app: opens the page a tapped notification asked for, follows later taps, keeps the
 * phone's address and key current, and turns the app's own notifications on the first time (Android asks for
 * the permission once; "off" in Settings stays off). It also tells the computer what happened, so a problem on
 * the phone can be seen from the computer.
 */
export function startPhoneNotify(): void {
  const native = !!(window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor?.isNativePlatform?.();
  const p = phoneNotify();
  if (!p) {
    if (native) hello({ plugin: false });
    return;
  }
  const go = (path?: string) => {
    if (path && /^#\/[\w\-/]*$/.test(path)) location.hash = path;
  };
  try {
    p.addListener("open", (e) => {
      go(e.path);
      // The phone also keeps the page for a cold start: taken here, so the next start does not jump to it again.
      void p.takeOpen().catch(() => undefined);
    });
  } catch {
    // an older app: taps still open the app
  }
  void p.takeOpen().then((r) => go(r.path), () => undefined);
  void p.status().then(
    async (s) => {
      let asked = true;
      try {
        asked = localStorage.getItem(ASKED) === "1";
        localStorage.setItem(ASKED, "1");
      } catch {
        asked = true;
      }
      // First time: the app's own notifications go on by themselves (no ntfy, nothing to set up).
      const live = s.live || (!asked && !s.chosen);
      if (!live && !s.push) return hello({ plugin: true, permission: s.permission, live: false });
      try {
        const now = await setPhoneNotify(live, s.push);
        hello({ plugin: true, permission: now.permission, live: now.live });
      } catch (e) {
        hello({ plugin: true, permission: s.permission, live: s.live, error: (e as Error).message });
      }
    },
    (e: Error) => hello({ plugin: true, error: e?.message || String(e) }),
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

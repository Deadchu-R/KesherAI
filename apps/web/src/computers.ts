import { api } from "./api";
import { getLocale } from "./i18n";

/** Sent when the user's computers (My devices) were looked up again: model lists reload. */
export const COMPUTERS_EVENT = "kesher-computers-changed";

/**
 * Looks for the user's other computers again (same Google account), checks
 * which answer now, and tells every model list to reload.
 *
 * @returns A short line for a toast: how many were found and how many are online.
 */
export async function refreshComputers(): Promise<string> {
  const he = getLocale() === "he";
  const st = await api<{ devices: Array<{ me: boolean; online: boolean; name: string }>; error: string | null; connected: boolean }>("/api/devices/sync", { method: "POST" });
  dispatchEvent(new Event(COMPUTERS_EVENT));
  if (!st.connected) return he ? "המחשב הזה לא מחובר לחשבון Google: התחבר בעיגול החשבון." : "This computer is not signed in to Google: sign in from the account circle.";
  if (st.error) return st.error;
  const others = st.devices.filter((d) => !d.me);
  const online = others.filter((d) => d.online);
  if (!others.length) return he ? "לא נמצאו מחשבים אחרים. במחשב השני: אותו חשבון Google, ולסמן \"המכשירים שלי יכולים להשתמש במחשב הזה\"." : "No other computers found. On the other one: the same Google account, and tick \"My devices can use this computer\".";
  return he
    ? `נמצאו ${others.length} מחשבים, ${online.length} זמינים${online.length ? `: ${online.map((d) => d.name).join(", ")}` : ""}.`
    : `Found ${others.length} computer(s), ${online.length} online${online.length ? `: ${online.map((d) => d.name).join(", ")}` : ""}.`;
}

/** What the phone gets to go on with: the open chat's title and last messages (text only). */
export interface Handoff {
  title: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
}

/**
 * The address that opens the phone app's own chat with the open chat's last messages (base64url JSON in the query).
 *
 * @param home - The phone app's home address.
 * @param h - The chat to go on with, or null for a new phone chat.
 * @returns The address.
 */
export function phoneHandoffUrl(home: string, h: Handoff | null): string {
  const base = `${home.replace(/\/$/, "")}/local.html`;
  if (!h?.messages.length) return `${base}?new=1`;
  const json = JSON.stringify({ t: h.title.slice(0, 120), m: h.messages.map((m) => [m.role === "user" ? "u" : "a", m.content]) });
  const b64 = btoa(String.fromCharCode(...new TextEncoder().encode(json))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${base}?handoff=${b64}`;
}

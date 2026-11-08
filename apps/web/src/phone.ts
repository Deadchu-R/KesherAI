import { withToken } from "./api";
import { createConversation, toast } from "./library";
import { getLocale } from "./i18n";

const L = (he: string, en: string) => (getLocale() === "he" ? he : en);

interface Shared {
  text?: string;
  subject?: string;
  files?: Array<{ path: string; name: string; mime: string; size: number }>;
  action?: "new" | "talk" | "photo";
}
interface SharePlugin {
  take(): Promise<Shared>;
  read(o: { path: string }): Promise<{ data: string }>;
  remove(o: { path: string }): Promise<void>;
  addListener(event: "shared", cb: () => void): unknown;
}

/** What a new conversation starts with: a draft in the box, voice mode, or the camera. */
export interface Opening {
  draft?: string;
  voice?: boolean;
  photo?: boolean;
}
const OPENING = "kesher-opening";

/** Takes (once) what a new conversation should open with. */
export function takeOpening(id: string): Opening | undefined {
  try {
    const raw = sessionStorage.getItem(`${OPENING}:${id}`);
    if (!raw) return undefined;
    sessionStorage.removeItem(`${OPENING}:${id}`);
    return JSON.parse(raw) as Opening;
  } catch {
    return undefined;
  }
}
/**
 * Opens a conversation with a line ready in its message box (e.g. "Open in chat" on the Unity page).
 *
 * @param id - The conversation.
 * @param draft - What to put in the box.
 */
export function openWithDraft(id: string, draft: string): void {
  setOpening(id, { draft });
  location.hash = `#/c/${id}`;
  // Already showing that chat: tell it.
  setTimeout(() => dispatchEvent(new CustomEvent("kesher-opening", { detail: id })), 50);
}

function setOpening(id: string, o: Opening): void {
  try {
    sessionStorage.setItem(`${OPENING}:${id}`, JSON.stringify(o));
  } catch {
    // only a convenience
  }
}

/**
 * Sends a file to a conversation's folder on the computer.
 *
 * @param id - The conversation.
 * @param name - The file's name.
 * @param data - Its bytes.
 * @returns The path on the computer.
 */
export async function uploadToConversation(id: string, name: string, data: Blob): Promise<string> {
  const res = await fetch(withToken(`/api/conversations/${id}/files?name=${encodeURIComponent(name)}`), { method: "POST", headers: { "content-type": "application/octet-stream" }, body: data });
  const j = (await res.json()) as { path?: string; error?: string };
  if (!res.ok || !j.path) throw new Error(j.error ?? String(res.status));
  return j.path;
}

const fromBase64 = (b64: string, type: string) => new Blob([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], { type });

/**
 * Inside the Android app: "Share → KesherAI" from other apps, and the
 * home-screen widget's buttons, open a new chat here (with the shared text
 * and files, in voice mode, or with the camera).
 */
export function startPhoneShare(): void {
  const plugin = (window as unknown as { Capacitor?: { Plugins?: { KesherShare?: SharePlugin } } }).Capacitor?.Plugins?.KesherShare;
  if (!plugin) return;
  let busy = false;
  const handle = async () => {
    if (busy) return;
    busy = true;
    try {
      const s = await plugin.take();
      if (!s || (!s.text && !s.subject && !s.files?.length && !s.action)) return;
      const id = await createConversation({ kind: "chat" });
      if (!id) return;
      if (s.action === "talk") return setOpening(id, { voice: true });
      if (s.action === "photo") return setOpening(id, { photo: true });
      if (s.action === "new") return;
      const lines: string[] = [];
      if (s.subject && !s.text?.includes(s.subject)) lines.push(s.subject);
      if (s.text) lines.push(s.text);
      for (const f of s.files ?? []) {
        try {
          const { data } = await plugin.read({ path: f.path });
          const path = await uploadToConversation(id, f.name, fromBase64(data, f.mime));
          lines.push(`[${L("קובץ מצורף", "Attached")}: ${path}]`);
        } catch (e) {
          toast(`${f.name}: ${(e as Error).message}`);
        } finally {
          void plugin.remove({ path: f.path }).catch(() => undefined);
        }
      }
      setOpening(id, { draft: `${lines.join("\n")}\n` });
      // The conversation page may already be showing: tell it.
      dispatchEvent(new CustomEvent("kesher-opening", { detail: id }));
    } catch (e) {
      toast((e as Error).message);
    } finally {
      busy = false;
    }
  };
  plugin.addListener("shared", () => void handle());
  void handle();
}

/**
 * Thin client for the core server's HTTP API (docs/API.md).
 *
 * On this computer no token is needed. A phone opens the UI once with
 * `?token=…` (shown on the desktop's Connections screen); the token is kept
 * in localStorage and sent with every request.
 */
import type { ChatMessage, ChatStreamEvent, ModelInfo, Asset } from "@kesher/shared";

const TOKEN_KEY = "kesher-token";

/** Where the Android app's own connect screen lives, when this page was opened from the app. */
const APP_HOME_KEY = "kesher-app-home";

/** @returns The Android app's connect screen, if this page runs inside the app. */
export function appHome(): string | null {
  try {
    return localStorage.getItem(APP_HOME_KEY);
  } catch {
    return null;
  }
}

/** Whether this page was opened from another device (a phone) with a pairing token. */
export function isRemote(): boolean {
  try {
    return !!localStorage.getItem(TOKEN_KEY);
  } catch {
    return false;
  }
}

/**
 * Leaves this computer: forgets its token here, and in the Android app also
 * removes it from the app's list of computers (by address, never the token).
 */
export function disconnectComputer(): void {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    // ignore
  }
  const home = appHome();
  location.href = home ? `${home.replace(/\/$/, "")}/?switch=1&forget=${encodeURIComponent(location.origin)}` : location.pathname;
}

(() => {
  const params = new URLSearchParams(location.search);
  // The Android app opens this page with ?app=<its own address>, so the menu can offer "Switch computer".
  const app = params.get("app");
  if (app && /^https?:\/\/localhost(:\d+)?\/?$/.test(app)) {
    try {
      localStorage.setItem(APP_HOME_KEY, app);
    } catch {
      // ignore
    }
  }
  const fromUrl = params.get("token");
  if (fromUrl) {
    try {
      localStorage.setItem(TOKEN_KEY, fromUrl);
    } catch {
      // ignore
    }
    history.replaceState(null, "", location.pathname + location.hash);
  } else if (app) {
    history.replaceState(null, "", location.pathname + location.hash);
  }
})();

/** @returns This device's own key (kd_…) when it has one, for the phone app's native parts. */
export function deviceKey(): string | undefined {
  const t = token();
  return t?.startsWith("kd_") ? t : undefined;
}

function token(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

/**
 * Adds the remote token to a URL, for `<img src>` and `EventSource`, which
 * cannot send headers.
 *
 * @param url - Relative URL.
 * @returns The URL with `token=` when one is stored.
 */
export function withToken(url: string): string {
  const tk = token();
  return tk ? `${url}${url.includes("?") ? "&" : "?"}token=${encodeURIComponent(tk)}` : url;
}

/**
 * Calls the API and parses JSON. Throws with the server's error message.
 *
 * @param path - e.g. `/api/models`.
 * @param init - fetch options; a plain object `body` is sent as JSON.
 * @returns Parsed JSON.
 */
export async function api<T>(path: string, init: Omit<RequestInit, "body"> & { body?: unknown } = {}): Promise<T> {
  const headers: Record<string, string> = { ...(init.headers as Record<string, string>) };
  const tk = token();
  if (tk) headers.authorization = `Bearer ${tk}`;
  let body: BodyInit | undefined;
  if (init.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(init.body);
  }
  const res = await fetch(path, { ...init, headers, body });
  const json = (await res.json().catch(() => ({}))) as T & { error?: string; code?: string; category?: string };
  if (!res.ok) throw new ApiError(json.error ?? `${res.status} ${res.statusText}`, res.status, json.code, json.category);
  return json;
}

/** An error from the server, with its machine-readable `code` when it sent one (e.g. `no-model`). */
export class ApiError extends Error {
  /**
   * @param message - Human-readable message.
   * @param status - HTTP status.
   * @param code - e.g. `no-model`.
   * @param category - For `no-model`: which category needs a model.
   */
  constructor(message: string, readonly status: number, readonly code?: string, readonly category?: string) {
    super(message);
  }
}

/**
 * Streams a chat reply.
 *
 * @param modelId - Global model id.
 * @param messages - Conversation so far.
 * @param onEvent - Called for every streamed event.
 * @param signal - Abort to stop generation.
 */
export async function streamChat(
  modelId: string,
  messages: ChatMessage[],
  onEvent: (e: ChatStreamEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  const tk = token();
  if (tk) headers.authorization = `Bearer ${tk}`;
  const res = await fetch("/api/chat", { method: "POST", headers, body: JSON.stringify({ modelId, messages }), signal });
  if (!res.ok || !res.body) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? `${res.status}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const data = block.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("\n");
      if (data) onEvent(JSON.parse(data) as ChatStreamEvent);
    }
  }
}

/** Result of `GET /api/models`. */
export interface ModelListing {
  models: ModelInfo[];
  errors: Array<{ providerId: string; message: string }>;
}

export type { ModelInfo, Asset, ChatMessage };

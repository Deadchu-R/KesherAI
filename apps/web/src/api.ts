/**
 * Thin client for the core server's HTTP API (docs/API.md).
 *
 * On this computer no token is needed. A phone opens the UI once with
 * `?token=…` (shown on the desktop's Connections screen); the token is kept
 * in localStorage and sent with every request.
 */
import type { ChatMessage, ChatStreamEvent, ModelInfo, Asset } from "@kesher/shared";

const TOKEN_KEY = "kesher-token";

(() => {
  const fromUrl = new URLSearchParams(location.search).get("token");
  if (fromUrl) {
    try {
      localStorage.setItem(TOKEN_KEY, fromUrl);
    } catch {
      // ignore
    }
    history.replaceState(null, "", location.pathname + location.hash);
  }
})();

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
  const json = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(json.error ?? `${res.status} ${res.statusText}`);
  return json;
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

/**
 * The Chrome extension's CDP transport (docs/research/browser-computer-control.md, Phase 2). The extension (0.3.0+)
 * attaches `chrome.debugger` to a tab when a CDP tool first needs it, forwards each command (`cdp-send`) and sends
 * every event back over the same WebSocket (`{ type: "cdp-event", tabId, method, params }`). So the recipes in cdp.ts
 * run unchanged on the user's own Chrome and on KesherAI's pane: one driver, two transports.
 *
 * The extension itself keeps the limits that belong to the browser: the optional `debugger` permission (asked the first
 * time), the per-site permission, only the CDP domains the recipes use, never KesherAI's own pages or browser pages.
 */
import type { CdpTransport } from "./cdp.js";

/** Sends one command to the extension and waits for its answer. */
export type ExtensionCall = <T>(action: string, args: Record<string, unknown>) => Promise<T>;

type Listener = (method: string, params: Record<string, unknown>) => void;

/** Per-tab CDP transports over the extension's WebSocket, and the events it sends back. */
export class ExtensionCdp {
  private listeners = new Map<number, Set<Listener>>();

  /** @param call - Sends one command to the extension (the bridge's own, with its time limit and Stop). */
  constructor(private call: ExtensionCall) {}

  /**
   * A tab's transport: commands go to the extension as `cdp-send`, events come from `event`.
   *
   * @param tabId - The Chrome tab's id.
   */
  transport(tabId: number): CdpTransport {
    return {
      send: (method, params) => this.call("cdp-send", { tabId, method, params: params ?? {} }),
      onEvent: (fn) => {
        let set = this.listeners.get(tabId);
        if (!set) this.listeners.set(tabId, (set = new Set()));
        set.add(fn);
        return () => {
          set.delete(fn);
          if (!set.size) this.listeners.delete(tabId);
        };
      },
    };
  }

  /**
   * One event from the extension, given to that tab's listeners. Bad messages are ignored.
   *
   * @param msg - `{ tabId, method, params }`.
   */
  event(msg: { tabId?: unknown; method?: unknown; params?: unknown }): void {
    if (typeof msg.tabId !== "number" || typeof msg.method !== "string") return;
    const params = msg.params && typeof msg.params === "object" ? (msg.params as Record<string, unknown>) : {};
    for (const fn of this.listeners.get(msg.tabId) ?? []) fn(msg.method, params);
  }
}

/**
 * Whether a connected extension can drive tabs over CDP: Chrome-family browsers with extension 0.3.0 or later that
 * said so when connecting (Firefox has no `chrome.debugger`, and keeps the page reader).
 *
 * @param hello - What the extension said when it connected.
 */
export function extensionHasCdp(hello: { browser?: string; version?: string; features?: string }): boolean {
  if (/firefox/i.test(hello.browser ?? "")) return false;
  if (!(hello.features ?? "").split(",").includes("cdp")) return false;
  const [a = 0, b = 0] = (hello.version ?? "").split(".").map((n) => Number(n) || 0);
  return a > 0 || b >= 3;
}

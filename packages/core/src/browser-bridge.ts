import { randomUUID } from "node:crypto";
import type { AgentTool } from "@kesher/agent";

/** The part of a WebSocket the bridge uses. */
export interface BridgeSocket {
  send(data: string): void;
  close(): void;
  on(event: "message", fn: (data: Buffer | string) => void): void;
  on(event: "close", fn: () => void): void;
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

/** A tab as the extension reports it. */
export interface BrowserTab {
  id: number;
  title: string;
  url: string;
  active: boolean;
}

/**
 * The link to the KesherAI browser extension: the extension connects to this
 * computer's server over a WebSocket, and the agent's browser tools send it
 * commands (list tabs, open, read, click, type, screenshot). It acts in the
 * user's own browser, where they are already signed in.
 */
/** KesherAI's own browser pane (the desktop app): carries out the same commands as the extension. */
export type PaneHandler = (action: string, args: Record<string, unknown>) => Promise<unknown>;

/** Sends the agent's browser commands to KesherAI's own pane or to the user's browser (the extension). */
export class BrowserBridge {
  private socket: BridgeSocket | undefined;
  private pane: PaneHandler | undefined;
  private pending = new Map<string, Pending>();
  private info: { browser?: string; version?: string; since?: number } = {};

  /** @returns Whether an extension is connected, and which browser. */
  status(): { connected: boolean; browser?: string; version?: string; since?: number; pane: boolean; extension: boolean } {
    return { connected: !!this.socket || !!this.pane, ...this.info, pane: !!this.pane, extension: !!this.socket };
  }

  /**
   * The desktop app's own browser pane (replacing an older one); `undefined` removes it.
   *
   * @param handler - Carries out one command in the pane.
   */
  attachPane(handler: PaneHandler | undefined): void {
    this.pane = handler;
  }

  /**
   * Takes a new connection from the extension (replacing an older one).
   *
   * @param socket - The WebSocket.
   * @param hello - What the extension said about itself.
   */
  attach(socket: BridgeSocket, hello: { browser?: string; version?: string }): void {
    this.socket?.close();
    this.socket = socket;
    this.info = { ...hello, since: Date.now() };
    socket.on("message", (raw) => {
      let msg: { id?: string; ok?: boolean; result?: unknown; error?: string; type?: string };
      try {
        msg = JSON.parse(String(raw)) as typeof msg;
      } catch {
        return;
      }
      if (msg.type === "ping") return socket.send(JSON.stringify({ type: "pong" }));
      const p = msg.id ? this.pending.get(msg.id) : undefined;
      if (!p) return;
      this.pending.delete(msg.id!);
      clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(new Error(msg.error ?? "The browser could not do that."));
    });
    socket.on("close", () => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      this.info = {};
      for (const [id, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error("The browser extension disconnected."));
        this.pending.delete(id);
      }
    });
  }

  /**
   * Sends one command to the extension.
   *
   * @param action - tabs, open, read, click, type, scroll, screenshot.
   * @param args - The command's arguments.
   * @param signal - Abort to stop waiting.
   * @returns The extension's answer.
   */
  call<T>(action: string, args: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
    // KesherAI's own pane first (the user watches it there); the user's browser when asked for, or without a pane.
    const pane = this.pane;
    if (pane && (args.browser !== "chrome" || !this.socket)) {
      const { browser: _b, ...rest } = args;
      return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`The browser did not answer "${action}" in time.`)), 60_000);
        signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("Stopped.")); }, { once: true });
        pane(action, rest).then((v) => { clearTimeout(timer); resolve(v as T); }, (e: Error) => { clearTimeout(timer); reject(e); });
      });
    }
    const socket = this.socket;
    if (!socket) return Promise.reject(new Error("The KesherAI browser extension is not connected. Install it from Settings → Browser, and keep the browser open."));
    const id = randomUUID();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`The browser did not answer "${action}" in time.`));
      }, 60_000);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      signal?.addEventListener("abort", () => {
        if (!this.pending.delete(id)) return;
        clearTimeout(timer);
        reject(new Error("Stopped."));
      }, { once: true });
      socket.send(JSON.stringify({ id, action, args }));
    });
  }
}

/**
 * The agent's browser tools, when the extension is connected. Looking at
 * pages asks first in "ask" mode (they may hold private things); acting on
 * them (open, click, type) asks unless the mode is "auto". The extension
 * never types into password fields.
 *
 * @param b - The bridge.
 * @returns The tools, or none when no browser is connected.
 */
export function browserTools(b: BrowserBridge): AgentTool[] {
  if (!b.status().connected) return [];
  const both = b.status().pane && b.status().extension;
  const tabArg = {
    tabId: { type: "number", description: "The tab's id from browser_tabs. Leave out for the tab in front." },
    ...(both ? { browser: { type: "string", enum: ["pane", "chrome"], description: "pane (default): KesherAI's own browser, which the user watches. chrome: the user's own browser, for sites where they are signed in." } } : {}),
  };
  const pageText = (r: { url: string; title: string; text: string; elements: string[] }) =>
    `${r.title}\n${r.url}\n\n${r.text}\n\nElements you can use (ref: what it is):\n${r.elements.join("\n") || "(none)"}`;
  return [
    {
      risk: "read",
      spec: {
        name: "browser_tabs",
        description: b.status().pane
          ? "List the tabs open in KesherAI's own browser pane (or, with browser: chrome, the user's own browser): id, title, address."
          : "List the tabs open in the user's own browser (where they are signed in): id, title, address.",
        inputSchema: { type: "object", properties: both ? { browser: tabArg.browser } : {} },
      },
      async run(input, ctx) {
        const tabs = await b.call<BrowserTab[]>("tabs", { browser: input.browser }, ctx.signal);
        return { output: tabs.map((t) => `${t.id}${t.active ? " (in front)" : ""}: ${t.title} — ${t.url}`).join("\n") || "No tabs." };
      },
    },
    {
      risk: "write",
      spec: {
        name: "browser_read",
        description: "Read a tab of the user's browser: its text and the buttons, links and fields on it, each with a ref for browser_click and browser_type.",
        inputSchema: { type: "object", properties: tabArg },
      },
      preview: async (input) => `Read the page in tab ${input.tabId ?? "in front"}`,
      async run(input, ctx) {
        return { output: pageText(await b.call("read", { tabId: input.tabId, browser: input.browser }, ctx.signal)) };
      },
    },
    {
      risk: "write",
      spec: {
        name: "browser_screenshot",
        description: "See a tab of the user's browser as a picture (brings it to the front).",
        inputSchema: { type: "object", properties: tabArg },
      },
      preview: async (input) => `Take a picture of tab ${input.tabId ?? "in front"}`,
      async run(input, ctx) {
        const r = await b.call<{ dataUrl: string }>("screenshot", { tabId: input.tabId, browser: input.browser }, ctx.signal);
        const [, mimeType = "image/png", data = ""] = /^data:([^;]+);base64,(.*)$/.exec(r.dataUrl) ?? [];
        return { output: "(the screenshot)", images: [{ mimeType, data }] };
      },
    },
    {
      risk: "exec",
      spec: {
        name: "browser_open",
        description: "Open an address in the user's browser, in a new tab (or in tabId). Returns the page like browser_read.",
        inputSchema: { type: "object", properties: { url: { type: "string" }, ...tabArg }, required: ["url"] },
      },
      preview: async (input) => `Open ${String(input.url)} in your browser`,
      async run(input, ctx) {
        const url = String(input.url ?? "");
        if (!/^https?:\/\//i.test(url)) throw new Error("Only http and https addresses.");
        return { output: pageText(await b.call("open", { url, tabId: input.tabId, browser: input.browser }, ctx.signal)) };
      },
    },
    {
      risk: "exec",
      spec: {
        name: "browser_click",
        description: "Click a button or link on a page, by its ref from browser_read. Returns the page after the click.",
        inputSchema: { type: "object", properties: { ref: { type: "number" }, ...tabArg }, required: ["ref"] },
      },
      preview: async (input) => `Click element ${String(input.ref)} in tab ${input.tabId ?? "in front"}`,
      async run(input, ctx) {
        return { output: pageText(await b.call("click", { ref: input.ref, tabId: input.tabId, browser: input.browser }, ctx.signal)) };
      },
    },
    {
      risk: "exec",
      spec: {
        name: "browser_type",
        description: "Type text into a field on a page, by its ref from browser_read; submit: true presses Enter. Never for passwords or card numbers: ask the user to type those.",
        inputSchema: { type: "object", properties: { ref: { type: "number" }, text: { type: "string" }, submit: { type: "boolean" }, ...tabArg }, required: ["ref", "text"] },
      },
      preview: async (input) => `Type "${String(input.text).slice(0, 200)}" into element ${String(input.ref)}${input.submit ? " and press Enter" : ""}`,
      async run(input, ctx) {
        return { output: pageText(await b.call("type", { ref: input.ref, text: String(input.text ?? ""), submit: !!input.submit, tabId: input.tabId, browser: input.browser }, ctx.signal)) };
      },
    },
  ];
}

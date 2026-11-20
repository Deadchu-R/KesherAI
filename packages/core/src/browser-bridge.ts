import { randomUUID } from "node:crypto";
import type { AgentTool } from "@kesher/agent";
import { BrowserLog, hostOf, untrusted, UNTRUSTED_RULE } from "./browser-safety.js";
import { CdpPage, type CdpTransport } from "./cdp.js";
import { cdpBrowserTools, isCdpRef, snapshotText } from "./browser-cdp-tools.js";

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
  /** Calls running now, so Stop can end them all (the chat's and every helper's). */
  private running = new Set<AbortController>();
  private stoppedAt = 0;
  /** What the browser tools did (the pane's activity strip, the phone). */
  readonly log = new BrowserLog();
  /** The last page read per browser and tab ("pane:front", "chrome:7"): ref → what the element is, for approval cards. */
  readonly labels = new Map<string, Map<string, string>>();

  /**
   * Stop (the pane's button, Ctrl+Alt+Esc): ends every browser command now and refuses new ones for 10 seconds, so
   * the chat and its helpers see "the user pressed Stop" and tell the user instead of going on.
   */
  stop(): void {
    this.stoppedAt = Date.now();
    for (const c of this.running) c.abort();
    this.running.clear();
    this.log.add({ tool: "stop", ok: true, note: "Stopped by the user" });
  }

  /** @returns Whether the browser tools acted in the last 15 seconds, and the last actions. */
  activity(n = 30): { active: boolean; stoppedAt: number; log: ReturnType<BrowserLog["last"]> } {
    // Calls ended by a Stop are logged just after it; they are not activity.
    const last = this.log.lastAt();
    return { active: Date.now() - last < 15_000 && last - this.stoppedAt > 2000, stoppedAt: this.stoppedAt, log: this.log.last(n) };
  }

  /** @throws Error while a Stop is fresh (10 seconds). */
  private gate(): void {
    if (Date.now() - this.stoppedAt < 10_000) throw new Error("The user pressed Stop. Do not continue using the browser; tell the user what you were doing and wait for them.");
  }

  /**
   * Runs one command with a time limit, ending it on the caller's abort or on Stop.
   *
   * @param action - For the timeout message.
   * @param start - Starts the command.
   * @param signal - The caller's abort.
   * @param onEnd - Cleanup when it ends early (the extension's pending entry).
   */
  private guarded<T>(action: string, start: () => Promise<T>, signal?: AbortSignal, onEnd?: () => void): Promise<T> {
    try {
      this.gate();
    } catch (e) {
      return Promise.reject(e as Error);
    }
    const ctl = new AbortController();
    this.running.add(ctl);
    return new Promise<T>((resolve, reject) => {
      let done = false;
      const end = (fn: () => void) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.running.delete(ctl);
        fn();
      };
      const timer = setTimeout(() => end(() => { onEnd?.(); reject(new Error(`The browser did not answer "${action}" in time.`)); }), 60_000);
      signal?.addEventListener("abort", () => end(() => { onEnd?.(); reject(new Error("Stopped.")); }), { once: true });
      ctl.signal.addEventListener("abort", () => end(() => { onEnd?.(); reject(new Error("The user pressed Stop in the browser. Do not continue using the browser; tell the user what you were doing.")); }), { once: true });
      start().then((v) => end(() => resolve(v)), (e: Error) => end(() => reject(e)));
    });
  }

  /** The pane's tabs that KesherAI can drive over CDP (Phase 1), by tab id. */
  private cdpTabs = new Map<number, CdpPage>();

  /**
   * A tab of the pane got its debugger (it opened, or its developer tools closed): its console and network are kept
   * from now on, and the CDP tools can act on it.
   *
   * @param tabId - The pane's tab id.
   * @param transport - The tab's CDP connection.
   * @param painted - Runs a capture while the tab is painted (a hidden tab is moved where it paints).
   */
  attachCdpTab(tabId: number, transport: CdpTransport, painted?: <T>(fn: () => Promise<T>) => Promise<T>): void {
    this.cdpTabs.get(tabId)?.dispose();
    const page = new CdpPage(transport, painted);
    this.cdpTabs.set(tabId, page);
    void page.enable();
  }

  /** A tab closed, or its debugger was taken (the user opened its developer tools). */
  detachCdpTab(tabId: number): void {
    this.cdpTabs.get(tabId)?.dispose();
    this.cdpTabs.delete(tabId);
  }

  /** The pane's tab a call means: its `tabId`, or the one in front. */
  async paneTabId(input: Record<string, unknown>, signal?: AbortSignal): Promise<number> {
    if (typeof input.tabId === "number") return input.tabId;
    const tabs = await this.call<BrowserTab[]>("tabs", {}, signal);
    const t = tabs.find((x) => x.active);
    if (!t) throw new Error("No tab is open in KesherAI's browser: open one with browser_open.");
    return t.id;
  }

  /**
   * Runs CDP steps on a tab of the pane, with the same time limit, abort and Stop as every browser command.
   *
   * @param input - The tool's input (`tabId`, `browser`).
   * @param fn - The steps.
   * @param signal - The caller's abort.
   * @throws Error for the user's own Chrome (the extension's CDP is Phase 2) or a tab without a debugger.
   */
  async withCdp<T>(input: Record<string, unknown>, fn: (page: CdpPage, tabId: number) => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (input.browser === "chrome" && this.socket) throw new Error("This tool works in KesherAI's own browser only (the user's Chrome gets it later). Use browser_read, browser_click and browser_type there.");
    if (!this.pane) throw new Error("This tool needs KesherAI's own browser, which runs in the desktop app.");
    const tabId = await this.paneTabId(input, signal);
    const page = this.cdpTabs.get(tabId);
    if (!page) throw new Error("KesherAI cannot inspect this tab now (are its developer tools open? close them and try again).");
    return this.guarded("cdp", () => fn(page, tabId), signal);
  }

  /** What a CDP ref is (`button "Send"`), from the tab's last snapshot, for approval cards. */
  cdpLabel(tabId: number, ref: string): string | undefined {
    return this.cdpTabs.get(tabId)?.labels.get(ref);
  }

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
   * A command for the pane itself (its tabs, a picture of it, a tap), for the phone's view of it.
   *
   * @param action - pane-state, pane-shot, pane-tap, pane-go, pane-nav, pane-select, pane-close, pane-new.
   * @param args - The command's arguments.
   * @returns The pane's answer.
   */
  paneCall<T>(action: string, args: Record<string, unknown> = {}): Promise<T> {
    if (!this.pane) return Promise.reject(new Error("KesherAI's browser is part of the desktop app: open KesherAI on the computer."));
    return this.pane(action, args) as Promise<T>;
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
      if (msg.ok) p.resolve(msg.result);
      else p.reject(new Error(msg.error ?? "The browser could not do that."));
    });
    socket.on("close", () => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      this.info = {};
      for (const [id, p] of this.pending) {
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
      return this.guarded(action, () => pane(action, rest) as Promise<T>, signal);
    }
    const socket = this.socket;
    if (!socket) return Promise.reject(new Error("The KesherAI browser extension is not connected. Install it from Settings → Browser, and keep the browser open."));
    const id = randomUUID();
    return this.guarded<T>(
      action,
      () =>
        new Promise<T>((resolve, reject) => {
          this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
          socket.send(JSON.stringify({ id, action, args }));
        }),
      signal,
      () => this.pending.delete(id),
    );
  }
}

/** A page as the pane or the extension reads it. */
interface PageRead {
  url: string;
  title: string;
  text: string;
  elements: string[];
}

export { hostOf };

/** Tools asked about every time, in every mode and whatever "Always" says (plan, Phase 0): their reason on the card. */
const ALWAYS_ASK: Record<string, string> = {
  browser_eval: "Runs code inside the web page: it can read and change anything on the page, so it is asked every time.",
  browser_upload: "Sends a file from this computer to the web site, so it is asked every time.",
  browser_download: "Downloads a file to this computer, so it is asked every time.",
};

/**
 * The agent's browser tools, when the extension is connected. Looking at
 * pages asks first in "ask" mode (they may hold private things); acting on
 * them (open, click, type) asks unless the mode is "auto". The extension
 * never types into password fields. Page text reaches the model marked as
 * untrusted data; every action goes to the bridge's log; approval cards name
 * the element ("button \"Send\"") and the site, not a bare ref.
 *
 * @param b - The bridge.
 * @param saveShot - Keeps a screenshot as an asset (its id), so the chat shows it as a small picture in the step.
 * @returns The tools, or none when no browser is connected.
 */
export function browserTools(b: BrowserBridge, saveShot?: (data: Buffer, mimeType: string) => Promise<string>): AgentTool[] {
  if (!b.status().connected) return [];
  const both = b.status().pane && b.status().extension;
  const tabArg = {
    tabId: { type: "number", description: "The tab's id from browser_tabs. Leave out for the tab in front." },
    ...(both ? { browser: { type: "string", enum: ["pane", "chrome"], description: "pane (default): KesherAI's own browser, which the user watches. chrome: the user's own browser, for sites where they are signed in." } } : {}),
  };
  /** Which browser a call goes to: the pane unless the user's own was asked for (and is there). */
  const target = (input: Record<string, unknown>) => (b.status().pane && (input.browser !== "chrome" || !b.status().extension) ? "pane" : "chrome");
  const labelKey = (input: Record<string, unknown>, tab?: unknown) => `${target(input)}:${typeof tab === "number" ? tab : "front"}`;
  /** Keeps what each ref is (for approval cards), then gives the page to the model as untrusted data. */
  const pageText = (r: PageRead, input: Record<string, unknown>) => {
    const refs = new Map<string, string>();
    for (const e of r.elements ?? []) {
      const m = /^\[?(?:ref=)?(\w+)\]?:\s*(.+)$/.exec(e);
      if (m) refs.set(m[1]!, m[2]!.slice(0, 120));
    }
    b.labels.set(labelKey(input, input.tabId), refs);
    if (input.tabId === undefined) b.labels.set(labelKey(input, "front"), refs);
    const body = `${r.title}\n${r.url}\n\n${r.text}\n\nElements you can use (ref: what it is):\n${r.elements?.join("\n") || "(none)"}`;
    return untrusted(hostOf(r.url) ?? r.url, body);
  };
  /** Whether a call goes over CDP: a snapshot ref ("e12") in KesherAI's own pane. */
  const viaCdp = (input: Record<string, unknown>) => isCdpRef(input.ref) && target(input) === "pane";
  /** What a ref is, from the last read or snapshot of that tab: `button "Send"`, or "element 7" when unknown. */
  const labelOf = async (input: Record<string, unknown>, signal?: AbortSignal) => {
    const ref = String(input.ref ?? "").trim();
    let label: string | undefined;
    if (viaCdp(input)) {
      const id = await b.paneTabId(input, signal).catch(() => undefined);
      label = id === undefined ? undefined : b.cdpLabel(id, ref);
    } else label = (b.labels.get(labelKey(input, input.tabId)) ?? b.labels.get(labelKey(input)))?.get(ref);
    return label ? `${label} (ref ${ref})` : `element ${ref}`;
  };
  // "Always allow" for the browser is per web site (like Claude in Chrome): the site of the address, or of the tab.
  const siteOf = (url: string): string | undefined => {
    const host = hostOf(url);
    // The host with its port: "Always" on localhost:5173 (a dev server) is not every local service.
    return host ? `site:${host}` : undefined;
  };
  const tabSite = async (input: Record<string, unknown>, signal?: AbortSignal): Promise<string | undefined> => {
    const tabs = await b.call<BrowserTab[]>("tabs", { browser: input.browser }, signal);
    const t = typeof input.tabId === "number" ? tabs.find((x) => x.id === input.tabId) : tabs.find((x) => x.active);
    return t ? siteOf(t.url) : undefined;
  };
  /** " on mail.example.com" for a card, or nothing when the tab is unknown. */
  const onSite = async (input: Record<string, unknown>, signal?: AbortSignal) => {
    const site = await tabSite(input, signal).catch(() => undefined);
    return site ? ` on ${site.slice(5)}` : "";
  };
  const scoped = (t: AgentTool): AgentTool => ({
    ...t,
    scopeOf: async (input, ctx) => (t.spec.name === "browser_open" ? siteOf(String(input.url ?? "")) : tabSite(input, ctx.signal)),
  });
  /** Logs each call (tool, site, what it acted on, result) and adds the always-ask rule. */
  const logged = (t: AgentTool): AgentTool => ({
    ...t,
    ...(ALWAYS_ASK[t.spec.name] ? { askFirst: () => ALWAYS_ASK[t.spec.name] } : {}),
    run: async (input, ctx) => {
      const what = input.url ? String(input.url) : input.ref !== undefined ? await labelOf(input, ctx.signal) : undefined;
      try {
        const out = await t.run(input, ctx);
        const url = /\n(https?:\/\/\S+)\n/.exec(out.output)?.[1];
        b.log.add({ tool: t.spec.name, ...(url ? { site: hostOf(url) } : {}), ...(what ? { target: what } : {}), ok: true });
        return out;
      } catch (e) {
        b.log.add({ tool: t.spec.name, ...(what ? { target: what } : {}), ok: false, note: (e as Error).message });
        throw e;
      }
    },
  });
  const tools: AgentTool[] = [
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
        description: `Read a tab of the user's browser: its text and the buttons, links and fields on it, each with a ref for browser_click and browser_type. ${UNTRUSTED_RULE}`,
        inputSchema: { type: "object", properties: tabArg },
      },
      preview: async (input, ctx) => `Read the page in tab ${input.tabId ?? "in front"}${await onSite(input, ctx.signal)}`,
      async run(input, ctx) {
        return { output: pageText(await b.call("read", { tabId: input.tabId, browser: input.browser }, ctx.signal), input) };
      },
    },
    {
      risk: "write",
      spec: {
        name: "browser_screenshot",
        description: b.status().pane
          ? "See a tab as a picture: the visible area (its pixels are what browser_click_at takes), full: true for the whole page, or ref (from browser_snapshot) for one element. In the user's own browser it brings the tab to the front."
          : "See a tab of the user's browser as a picture (brings it to the front).",
        inputSchema: { type: "object", properties: { ...tabArg, ...(b.status().pane ? { full: { type: "boolean" }, ref: { type: "string" } } : {}) } },
      },
      preview: async (input, ctx) => `Take a picture of ${input.ref ? await labelOf(input, ctx.signal) : input.full ? "the whole page" : `tab ${input.tabId ?? "in front"}`}${await onSite(input, ctx.signal)}`,
      async run(input, ctx) {
        let mimeType = "image/png";
        let data = "";
        // KesherAI's pane: over CDP, in CSS pixels (so browser_click_at matches); the old way when the tab has no debugger.
        const cdp = target(input) === "pane" ? await b.withCdp(input, (p) => p.screenshot({ full: input.full === true, ...(isCdpRef(input.ref) ? { ref: String(input.ref) } : {}) }), ctx.signal).catch((e: Error) => (input.full || input.ref ? Promise.reject(e) : undefined)) : undefined;
        if (cdp) data = cdp.data.toString("base64");
        else {
          const r = await b.call<{ dataUrl: string }>("screenshot", { tabId: input.tabId, browser: input.browser }, ctx.signal);
          [, mimeType = "image/png", data = ""] = /^data:([^;]+);base64,(.*)$/.exec(r.dataUrl) ?? [];
        }
        // The chat's thumbnail is a nicety: the model still gets the picture when keeping it fails.
        const id = saveShot && data ? await saveShot(Buffer.from(data, "base64"), mimeType).catch(() => undefined) : undefined;
        return { output: "(the screenshot)", images: [{ mimeType, data }], ...(id ? { assetIds: [id] } : {}) };
      },
    },
    {
      risk: "exec",
      spec: {
        name: "browser_open",
        description: "Open an address in the user's browser, in a new tab (or in tabId). Returns the page like browser_read.",
        inputSchema: { type: "object", properties: { url: { type: "string" }, ...tabArg }, required: ["url"] },
      },
      preview: async (input) => `Open ${String(input.url)} in ${target(input) === "pane" ? "KesherAI's browser" : "your browser"}`,
      async run(input, ctx) {
        const url = String(input.url ?? "");
        if (!/^https?:\/\//i.test(url)) throw new Error("Only http and https addresses.");
        return { output: pageText(await b.call("open", { url, tabId: input.tabId, browser: input.browser }, ctx.signal), input) };
      },
    },
    {
      risk: "exec",
      spec: {
        name: "browser_click",
        description: b.status().pane
          ? "Click a button or link on a page by its ref: from browser_snapshot (e12) in KesherAI's browser, or from browser_read (a number). Returns the page after the click."
          : "Click a button or link on a page, by its ref from browser_read. Returns the page after the click.",
        inputSchema: { type: "object", properties: { ref: { type: "string", description: "e12 from browser_snapshot, or a number from browser_read." }, ...(b.status().pane ? { double: { type: "boolean" } } : {}), ...tabArg }, required: ["ref"] },
      },
      preview: async (input, ctx) => `${input.double ? "Double-click" : "Click"} ${await labelOf(input, ctx.signal)}${await onSite(input, ctx.signal)}`,
      async run(input, ctx) {
        if (viaCdp(input)) return { output: await b.withCdp(input, async (p) => (await p.click(String(input.ref), { double: input.double === true }), snapshotText(p)), ctx.signal) };
        return { output: pageText(await b.call("click", { ref: Number(input.ref), tabId: input.tabId, browser: input.browser }, ctx.signal), input) };
      },
    },
    {
      risk: "exec",
      spec: {
        name: "browser_type",
        description: "Type text into a field on a page by its ref (from browser_snapshot or browser_read), replacing what is in it; submit: true presses Enter. Never for passwords or card numbers: ask the user to type those.",
        inputSchema: { type: "object", properties: { ref: { type: "string", description: "e12 from browser_snapshot, or a number from browser_read." }, text: { type: "string" }, submit: { type: "boolean" }, ...tabArg }, required: ["ref", "text"] },
      },
      preview: async (input, ctx) => `Type "${String(input.text).slice(0, 200)}" into ${await labelOf(input, ctx.signal)}${await onSite(input, ctx.signal)}${input.submit ? " and press Enter" : ""}`,
      async run(input, ctx) {
        if (viaCdp(input)) return { output: await b.withCdp(input, async (p) => (await p.type(String(input.ref), String(input.text ?? ""), !!input.submit), snapshotText(p)), ctx.signal) };
        return { output: pageText(await b.call("type", { ref: Number(input.ref), text: String(input.text ?? ""), submit: !!input.submit, tabId: input.tabId, browser: input.browser }, ctx.signal), input) };
      },
    },
  ];
  // KesherAI's own pane: the CDP tools (snapshot refs, console, network…); the user's Chrome gets them in Phase 2.
  if (b.status().pane) tools.push(...cdpBrowserTools(b, { tabArg, onSite }));
  return tools.map((t) => logged(t.spec.name === "browser_tabs" ? t : scoped(t)));
}

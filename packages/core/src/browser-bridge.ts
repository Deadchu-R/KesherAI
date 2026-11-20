import { randomUUID } from "node:crypto";
import type { AgentTool } from "@kesher/agent";
import { BrowserLog, hostOf, untrusted, UNTRUSTED_RULE } from "./browser-safety.js";
import { ControlLog } from "./control-policy.js";
import { withControlInfo } from "./control-gate.js";
import { CdpPage, type CdpTransport } from "./cdp.js";
import { cdpBrowserTools, isCdpRef, snapshotText } from "./browser-cdp-tools.js";
import { ExtensionCdp, extensionHasCdp } from "./browser-ext-cdp.js";
import { browserFindTool, matchSnapshot } from "./vision-find-tools.js";
import type { Grounding } from "./vision-service.js";

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
  /** The extension's CDP (Chrome, extension 0.3.0+), and the user's Chrome tabs KesherAI drives over it. */
  private extCdp: ExtensionCdp | undefined;
  private chromeTabs = new Map<number, CdpPage>();
  /** Calls running now, so Stop can end them all (the chat's and every helper's). */
  private running = new Set<AbortController>();
  private stoppedAt = 0;
  /** What the browser tools did (the pane's activity strip, the phone). */
  readonly log = new BrowserLog();
  /** Safety v2's decisions for browser and computer actions of every chat (control-policy.ts): the action log. */
  readonly decisions = new ControlLog();
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
    // The user's Chrome: let go of every tab, so Chrome's "debugging" bar goes away too.
    if (this.socket && this.chromeTabs.size) {
      this.socket.send(JSON.stringify({ id: randomUUID(), action: "cdp-detach-all", args: {} }));
      for (const p of this.chromeTabs.values()) p.dispose();
      this.chromeTabs.clear();
    }
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
   * @param ms - The time limit (default 60 s; longer while Chrome asks the user for a permission).
   */
  private guarded<T>(action: string, start: () => Promise<T>, signal?: AbortSignal, onEnd?: () => void, ms = 60_000): Promise<T> {
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
      const timer = setTimeout(() => end(() => { onEnd?.(); reject(new Error(`The browser did not answer "${action}" in time.`)); }), ms);
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
    if (this.cdpTarget(input) === "chrome") {
      const ext = this.extCdp;
      if (!ext)
        throw new Error(
          /firefox/i.test(this.info.browser ?? "")
            ? "Firefox has no debugger for extensions: use browser_read, browser_click and browser_type (number refs) there."
            : "The KesherAI extension in the user's browser is older than 0.3.0: ask the user to update it (Settings → Browser). Until then use browser_read, browser_click and browser_type there.",
        );
      const tabId = await this.cdpTabId(input, signal);
      let page = this.chromeTabs.get(tabId);
      if (!page) {
        // The first CDP step on this tab: the extension may ask the user for the debugger and the site (up to 2 min).
        await this.guarded("attach", () => this.sendExt("cdp-attach", { tabId }), signal, undefined, 150_000);
        const front = <R>(f: () => Promise<R>) => this.sendExt("front", { tabId }).then(f);
        page = new CdpPage(ext.transport(tabId), front);
        this.chromeTabs.set(tabId, page);
        await page.enable();
      }
      const p = page;
      return this.guarded("cdp", () => fn(p, tabId), signal);
    }
    if (!this.pane) throw new Error("This tool needs KesherAI's own browser, which runs in the desktop app.");
    const tabId = await this.paneTabId(input, signal);
    const page = this.cdpTabs.get(tabId);
    if (!page) throw new Error("KesherAI cannot inspect this tab now (are its developer tools open? close them and try again).");
    return this.guarded("cdp", () => fn(page, tabId), signal);
  }

  /** Which browser a call goes to: KesherAI's pane unless the user's own was asked for (or there is no pane). */
  cdpTarget(input: Record<string, unknown>): "pane" | "chrome" {
    return this.pane && (input.browser !== "chrome" || !this.socket) ? "pane" : "chrome";
  }

  /** Whether CDP tools can act on the browser a call goes to (the pane, or Chrome with extension 0.3.0+). */
  canCdp(input: Record<string, unknown>): boolean {
    return this.cdpTarget(input) === "pane" ? !!this.pane : !!this.extCdp;
  }

  /** The tab a CDP call means, in its browser: its `tabId`, or the one in front. */
  async cdpTabId(input: Record<string, unknown>, signal?: AbortSignal): Promise<number> {
    if (this.cdpTarget(input) === "pane") return this.paneTabId(input, signal);
    if (typeof input.tabId === "number") return input.tabId;
    const tabs = await this.call<BrowserTab[]>("tabs", { browser: "chrome" }, signal);
    const t = tabs.find((x) => x.active);
    if (!t) throw new Error("No tab is open in the user's browser.");
    return t.id;
  }

  /** Brings a tab to the front, in the pane or in the user's Chrome. */
  async frontTab(input: Record<string, unknown>, signal?: AbortSignal): Promise<number> {
    const id = await this.cdpTabId(input, signal);
    if (this.cdpTarget(input) === "pane") await this.paneCall("pane-select", { id });
    else await this.guarded("front", () => this.sendExt("front", { tabId: id }), signal);
    return id;
  }

  /** Closes a tab, in the pane or in the user's Chrome. */
  async closeTab(input: Record<string, unknown>, signal?: AbortSignal): Promise<number> {
    const id = await this.cdpTabId(input, signal);
    if (this.cdpTarget(input) === "pane") await this.paneCall("pane-close", { id });
    else await this.guarded("close", () => this.sendExt("close", { tabId: id }), signal);
    return id;
  }

  /**
   * What a CDP ref is (`button "Send"`), from the tab's last snapshot, for approval cards.
   *
   * @param browser - Which browser's tab (default KesherAI's pane).
   */
  cdpLabel(tabId: number, ref: string, browser: "pane" | "chrome" = "pane"): string | undefined {
    return (browser === "chrome" ? this.chromeTabs : this.cdpTabs).get(tabId)?.labels.get(ref);
  }

  /**
   * The pane's tab in front, for the user's own Debug drawer (not the model): no Stop gate and no action log, so
   * looking at the console still works right after a Stop. Same time limit.
   *
   * @param fn - What to do with the tab.
   * @throws Error without a pane, a tab, or the tab's debugger.
   */
  async userCdp<T>(fn: (page: CdpPage, tabId: number) => Promise<T>): Promise<T> {
    if (!this.pane) throw new Error("KesherAI's browser is part of the desktop app: open KesherAI on the computer.");
    const tabId = await this.paneTabId({});
    const page = this.cdpTabs.get(tabId);
    if (!page) throw new Error("KesherAI cannot inspect this tab now (are its developer tools open? close them and try again).");
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error("The browser did not answer in time.")), 60_000)));
    try {
      return await Promise.race([fn(page, tabId), late]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** @returns Whether an extension is connected, and which browser. */
  status(): { connected: boolean; browser?: string; version?: string; since?: number; pane: boolean; extension: boolean; extensionCdp: boolean } {
    return { connected: !!this.socket || !!this.pane, ...this.info, pane: !!this.pane, extension: !!this.socket, extensionCdp: !!this.extCdp };
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
   * @param hello - What the extension said about itself (`features: "cdp"` from 0.3.0 in Chrome-family browsers).
   */
  attach(socket: BridgeSocket, hello: { browser?: string; version?: string; features?: string }): void {
    this.socket?.close();
    this.socket = socket;
    const { features: _f, ...info } = hello;
    this.info = { ...info, since: Date.now() };
    const ext = extensionHasCdp(hello) ? new ExtensionCdp((action, args) => this.sendExt(action, args)) : undefined;
    this.extCdp = ext;
    socket.on("message", (raw) => {
      let msg: { id?: string; ok?: boolean; result?: unknown; error?: string; type?: string; tabId?: unknown; method?: unknown; params?: unknown; reason?: unknown };
      try {
        msg = JSON.parse(String(raw)) as typeof msg;
      } catch {
        return;
      }
      if (msg.type === "ping") return socket.send(JSON.stringify({ type: "pong" }));
      if (msg.type === "cdp-event") return ext?.event(msg);
      if (msg.type === "cdp-detached" && typeof msg.tabId === "number") {
        this.chromeTabs.get(msg.tabId)?.dispose();
        this.chromeTabs.delete(msg.tabId);
        // "Cancel" on Chrome's "started debugging this browser" bar is the user's Stop.
        if (msg.reason === "canceled_by_user") this.stop();
        return;
      }
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
      this.extCdp = undefined;
      for (const p of this.chromeTabs.values()) p.dispose();
      this.chromeTabs.clear();
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
    if (!this.socket) return Promise.reject(new Error("The KesherAI browser extension is not connected. Install it from Settings → Browser, and keep the browser open."));
    let id = "";
    return this.guarded<T>(
      action,
      () => {
        const sent = this.sendExt<T>(action, args);
        id = this.lastId;
        return sent;
      },
      signal,
      () => this.pending.delete(id),
    );
  }

  /** The id of the last command sent to the extension (so a guarded call can drop its pending entry). */
  private lastId = "";

  /**
   * Sends one command to the extension and waits for its answer, with no time limit or Stop of its own (callers wrap
   * it in `guarded`; CDP steps run inside a guarded tool call already). An answer that never comes is dropped after
   * three minutes, so nothing waits for ever.
   */
  private sendExt<T>(action: string, args: Record<string, unknown>): Promise<T> {
    const socket = this.socket;
    if (!socket) return Promise.reject(new Error("The KesherAI browser extension disconnected."));
    const id = randomUUID();
    this.lastId = id;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`The browser did not answer "${action}" in time.`));
      }, 180_000);
      timer.unref?.();
      const done = (fn: () => void) => {
        clearTimeout(timer);
        fn();
      };
      this.pending.set(id, { resolve: (v) => done(() => resolve(v as T)), reject: (e) => done(() => reject(e)) });
      socket.send(JSON.stringify({ id, action, args }));
    });
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
 * @param opts.ffmpeg - FFmpeg's program when it is on the computer (WebM recordings); never downloads it.
 * @returns The tools, or none when no browser is connected.
 */
export function browserTools(b: BrowserBridge, saveShot?: (data: Buffer, mimeType: string) => Promise<string>, opts: { ffmpeg?: () => Promise<string | undefined>; vision?: () => Grounding | undefined } = {}): AgentTool[] {
  if (!b.status().connected) return [];
  const both = b.status().pane && b.status().extension;
  /** Whether snapshot refs and CDP options exist (KesherAI's pane, or Chrome with extension 0.3.0+). */
  const cdpAny = b.status().pane || b.status().extensionCdp;
  const tabArg = {
    tabId: { type: "number", description: "The tab's id from browser_tabs. Leave out for the tab in front." },
    ...(both ? { browser: { type: "string", enum: ["pane", "chrome"], description: "pane (default): KesherAI's own browser, which the user watches. chrome: the user's own browser, for sites where they are signed in." } } : {}),
  };
  /** Which browser a call goes to: the pane unless the user's own was asked for (and is there). */
  const target = (input: Record<string, unknown>) => b.cdpTarget(input);
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
  /** Whether a call goes over CDP: a snapshot ref ("e12") in KesherAI's own pane or in Chrome (extension 0.3.0+). */
  const viaCdp = (input: Record<string, unknown>) => isCdpRef(input.ref) && b.canCdp(input);
  /** What a ref is, from the last read or snapshot of that tab: `button "Send"`, or "element 7" when unknown. */
  const labelOf = async (input: Record<string, unknown>, signal?: AbortSignal) => {
    const ref = String(input.ref ?? "").trim();
    let label: string | undefined;
    if (viaCdp(input)) {
      const id = await b.cdpTabId(input, signal).catch(() => undefined);
      label = id === undefined ? undefined : b.cdpLabel(id, ref, target(input));
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
        description: cdpAny
          ? "See a tab as a picture: the visible area (its pixels are what browser_click_at takes), full: true for the whole page, or ref (from browser_snapshot) for one element. In the user's own browser it brings the tab to the front."
          : "See a tab of the user's browser as a picture (brings it to the front).",
        inputSchema: { type: "object", properties: { ...tabArg, ...(cdpAny ? { full: { type: "boolean" }, ref: { type: "string" } } : {}) } },
      },
      preview: async (input, ctx) => `Take a picture of ${input.ref ? await labelOf(input, ctx.signal) : input.full ? "the whole page" : `tab ${input.tabId ?? "in front"}`}${await onSite(input, ctx.signal)}`,
      async run(input, ctx) {
        let mimeType = "image/png";
        let data = "";
        // KesherAI's pane: over CDP, in CSS pixels (so browser_click_at matches); the old way when the tab has no debugger.
        const cdp = b.canCdp(input) ? await b.withCdp(input, (p) => p.screenshot({ full: input.full === true, ...(isCdpRef(input.ref) ? { ref: String(input.ref) } : {}) }), ctx.signal).catch((e: Error) => (input.full || input.ref ? Promise.reject(e) : undefined)) : undefined;
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
        description: cdpAny
          ? "Click a button or link on a page by its ref: from browser_snapshot (e12), or from browser_read (a number). Returns the page after the click."
          : "Click a button or link on a page, by its ref from browser_read. Returns the page after the click.",
        inputSchema: { type: "object", properties: { ref: { type: "string", description: "e12 from browser_snapshot, or a number from browser_read." }, ...(cdpAny ? { double: { type: "boolean" } } : {}), ...tabArg }, required: ["ref"] },
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
  // The CDP tools (snapshot refs, console, network…): KesherAI's own pane, and the user's Chrome with extension 0.3.0+.
  if (b.status().pane || b.status().extensionCdp) tools.push(...cdpBrowserTools(b, { tabArg, onSite, ...(saveShot ? { saveAsset: saveShot } : {}), ...(opts.ffmpeg ? { ffmpeg: opts.ffmpeg } : {}) }));
  // browser_find_visual (Phase 6): the page's accessibility snapshot first, then the local vision model.
  if ((b.status().pane || b.status().extensionCdp) && opts.vision)
    tools.push(
      browserFindTool({
        tabArg,
        vision: opts.vision,
        snapshotMatch: (input, query, signal) => b.withCdp(input, async (p) => matchSnapshot((await p.snapshot()).tree, query), signal),
        shot: async (input, signal) => {
          const s = await b.withCdp(input, (p) => p.screenshot(), signal);
          return { png: s.data, width: s.width, height: s.height };
        },
        around: async (input, x, y, signal) => (await b.withCdp(input, (p) => p.screenshot({ area: { x: x - 120, y: y - 75, width: 240, height: 150 } }), signal)).data,
      }),
    );
  /** Where a call acts, for safety v2's gate and approval card v2: the site, the element and a picture of it. */
  const where = async (input: Record<string, unknown>, ctx: { signal: AbortSignal }) => {
    let url = typeof input.url === "string" ? input.url : undefined;
    if (!url) {
      const tabs = await b.call<BrowserTab[]>("tabs", { browser: input.browser }, ctx.signal).catch(() => [] as BrowserTab[]);
      url = (typeof input.tabId === "number" ? tabs.find((x) => x.id === input.tabId) : tabs.find((x) => x.active))?.url;
    }
    const site = url ? hostOf(url) : undefined;
    const ref = input.ref !== undefined ? String(input.ref) : "";
    return {
      ...(site ? { site } : {}),
      ...(url ? { url } : {}),
      ...(ref ? { target: await labelOf(input, ctx.signal) } : {}),
      ...(typeof input.text === "string" ? { typedChars: input.text.length } : {}),
      // The element's own picture over CDP (a snapshot ref): only made when a card is shown; at most 1.5 MB.
      ...(ref && viaCdp(input)
        ? { crop: async () => { const shot = await b.withCdp(input, (p) => p.screenshot({ ref }), ctx.signal); return shot.data.length <= 1.5 * 1024 * 1024 ? shot.data : undefined; } }
        : // A click at a point (browser_find_visual's answer): the area around it, so the card shows what is hit.
          !ref && typeof input.x === "number" && typeof input.y === "number" && b.canCdp(input)
          ? { crop: async () => (await b.withCdp(input, (p) => p.screenshot({ area: { x: Number(input.x) - 120, y: Number(input.y) - 75, width: 240, height: 150 } }), ctx.signal)).data }
          : {}),
    };
  };
  return tools.map((t) => withControlInfo(logged(t.spec.name === "browser_tabs" ? t : scoped(t)), where));
}

/**
 * The Chrome DevTools Protocol (CDP) recipes for the model's browser tools (docs/research/browser-computer-control.md,
 * Phase 1). One `CdpPage` per tab of KesherAI's own browser pane, over any `CdpTransport` (the pane's Electron
 * `webContents.debugger` today; the Chrome extension's `chrome.debugger` later, Phase 2):
 *
 * - `snapshot`: the page's accessibility tree as text, each control with a ref ("e12") that names a DOM node, so the
 *   model acts on an element, not a pixel, and works with text-only local models. Refs die on the next snapshot and on
 *   a navigation. Hidden elements (display: none, aria-hidden) are not in the tree.
 * - Acting by ref: click, hover, type (never into password or card fields), select, scroll, file upload.
 * - Keys, coordinates (from a screenshot), waiting for text, back / forward / reload, JavaScript (asked every time).
 * - Ring buffers of the console and the network since the tab opened; headers, sign-in fields and secret-looking
 *   address parameters are hidden before anything reaches the model (browser-safety.ts).
 * - Screenshots of the visible area, the whole page or one element, in CSS pixels (so `clickAt` matches the picture).
 *
 * Everything here talks CDP only, so it is tested with a fake transport and with a real Chromium.
 */
import { redactBody, redactHeaders, redactUrl } from "./browser-safety.js";

/** A CDP connection to one page: commands, and every event. */
export interface CdpTransport {
  /** Sends a command and resolves with its result. */
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  /** Calls `fn` for every event; returns a function that stops it. */
  onEvent(fn: (method: string, params: Record<string, unknown>) => void): () => void;
}

/** One console line (also uncaught errors and browser log entries). */
export interface ConsoleEntry {
  at: number;
  level: string;
  text: string;
  where?: string;
}

/** One network request as the buffer keeps it. */
export interface NetworkEntry {
  /** A short number for the model ("7"), stable while the tab lives. */
  n: number;
  /** CDP's own id, for the body. */
  id: string;
  at: number;
  method: string;
  url: string;
  type?: string;
  status?: number;
  mimeType?: string;
  size?: number;
  failed?: string;
  requestHeaders?: Record<string, unknown>;
  responseHeaders?: Record<string, unknown>;
  hasPostData?: boolean;
}

/** A pop-up (alert, confirm, prompt, beforeunload) the page opened and nobody answered yet. */
export interface OpenDialog {
  type: string;
  message: string;
  defaultPrompt?: string;
}

/** One element as `inspect` describes it (the Debug drawer's Elements tab, `browser_inspect`). */
export interface InspectInfo {
  tag: string;
  /** The element's attributes; values of secret-looking ones are hidden. */
  attributes: Record<string, string>;
  /** Where it is in the visible area, in CSS pixels. */
  box: { x: number; y: number; width: number; height: number };
  /** The computed styles that matter for layout and look (INSPECT_STYLES). */
  styles: Record<string, string>;
  /** Its visible text, cut to 300 characters. */
  text: string;
  /** Its HTML, cut to 1500 characters (secret values hidden). */
  html: string;
  /** Its content is wider or taller than its box and hidden or cut ("no cut text" checks). */
  cut: boolean;
}

/** How the page is shown: its size (a 390 px phone, a 1280 px desktop, or the pane's own) and its colors. */
export interface Emulation {
  device: "phone" | "desktop" | "none";
  scheme: "dark" | "light" | "auto";
}

/** One frame of a recording: a PNG picture and when it came. */
export interface RecordedFrame {
  data: Buffer;
  at: number;
}

/** What "Try my change" found after a reload: problems, and the page at 390 px and on a desktop. */
export interface TryResult {
  url: string;
  errors: ConsoleEntry[];
  failed: NetworkEntry[];
  views: Array<{ device: "phone" | "desktop"; data: Buffer; width: number; height: number; /** CSS pixels wider than the view (0: fits). */ overflow: number }>;
}

interface AxValue {
  value?: unknown;
}
interface AxNode {
  nodeId: string;
  ignored?: boolean;
  role?: AxValue;
  name?: AxValue;
  value?: AxValue;
  properties?: Array<{ name: string; value: AxValue }>;
  childIds?: string[];
  parentId?: string;
  backendDOMNodeId?: number;
}

/** Roles that get a ref: what a person can click, type into or choose. */
const ACTIONABLE = new Set([
  "button", "link", "textbox", "searchbox", "combobox", "checkbox", "radio", "menuitem", "menuitemcheckbox", "menuitemradio",
  "tab", "switch", "slider", "spinbutton", "option", "listbox", "treeitem", "textarea", "PopUpButton", "ComboBoxGrouping",
]);
/** Roles that only group others: not printed, their children are (one level up). */
const SKIP = new Set(["generic", "none", "presentation", "InlineTextBox", "LineBreak", "RootWebArea", "WebArea", "Section", "paragraph", "LayoutTable", "LayoutTableRow", "LayoutTableCell", "group", "ListMarker", "LabelText", "MenuListPopup"]);
/** Controls whose inner parts are shown (their options, items or tabs); other controls' insides only repeat them. */
const CONTAINERS = new Set(["combobox", "listbox", "menu", "menubar", "tablist", "tree", "radiogroup", "PopUpButton"]);
/** Properties worth showing next to an element. */
const SHOWN = ["checked", "pressed", "selected", "expanded", "disabled", "required", "level", "focused", "invalid"];

/** Keys by name for `pressKey` (the rest: one character). */
const KEYS: Record<string, { code: string; keyCode: number; text?: string }> = {
  Enter: { code: "Enter", keyCode: 13, text: "\r" },
  Tab: { code: "Tab", keyCode: 9 },
  Escape: { code: "Escape", keyCode: 27 },
  Backspace: { code: "Backspace", keyCode: 8 },
  Delete: { code: "Delete", keyCode: 46 },
  Space: { code: "Space", keyCode: 32, text: " " },
  ArrowUp: { code: "ArrowUp", keyCode: 38 },
  ArrowDown: { code: "ArrowDown", keyCode: 40 },
  ArrowLeft: { code: "ArrowLeft", keyCode: 37 },
  ArrowRight: { code: "ArrowRight", keyCode: 39 },
  Home: { code: "Home", keyCode: 36 },
  End: { code: "End", keyCode: 35 },
  PageUp: { code: "PageUp", keyCode: 33 },
  PageDown: { code: "PageDown", keyCode: 34 },
};
const MODIFIERS: Record<string, number> = { Alt: 1, Control: 2, Ctrl: 2, Meta: 4, Shift: 8 };

/** The most lines and characters a snapshot gives the model. */
const SNAPSHOT_LINES = 800;
const SNAPSHOT_CHARS = 24_000;
/** How many console lines and requests a tab keeps. */
const BUFFER = 300;
/** A recording keeps at most this many frames and this long (then it stops by itself). */
const RECORD_FRAMES = 300;
const RECORD_MS = 60_000;
/** The sizes `emulate` gives the page (CSS pixels): a phone like Roee's checks (390 wide), and a laptop. */
export const PHONE_VIEW = { width: 390, height: 844 };
export const DESKTOP_VIEW = { width: 1280, height: 800 };
/** The computed styles `inspect` shows: what decides an element's place, size and look. */
const INSPECT_STYLES = ["display", "position", "width", "height", "margin", "padding", "box-sizing", "flex", "flex-direction", "gap", "grid-template-columns", "overflow", "white-space", "text-overflow", "font-size", "font-family", "font-weight", "line-height", "color", "background-color", "border", "border-radius", "z-index", "opacity", "visibility", "direction", "text-align"];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const str = (v: unknown) => (v === undefined || v === null ? "" : String(v));

/**
 * One tab driven over CDP. Create it when the tab opens (so its console and network are kept from the start), then
 * call `enable`; `dispose` when the tab closes or the transport detaches.
 */
export class CdpPage {
  /** ref ("e12") → backend DOM node id, from the last snapshot. */
  private refs = new Map<string, number>();
  /** The same for the user's own Elements view (the Debug drawer), apart from the model's. */
  private userRefs = new Map<string, number>();
  /** ref → what it is (`button "Send"`), for approval cards. */
  readonly labels = new Map<string, string>();
  private console: ConsoleEntry[] = [];
  private network = new Map<string, NetworkEntry>();
  private nextRequest = 1;
  private loading = false;
  private off: () => void;
  /** The pop-up waiting for an answer, if any. */
  dialog: OpenDialog | undefined;
  /** The element the user picked on the page (Debug drawer → Pick), and whether pick mode is on. */
  picked: number | undefined;
  picking = false;
  /** How the page is shown now (`emulate`). */
  emulation: Emulation = { device: "none", scheme: "auto" };
  /** The recording running now (`startRecording`). */
  private rec: { frames: RecordedFrame[]; started: number; timer: ReturnType<typeof setTimeout> } | undefined;
  /** Scale of the last screenshot (picture pixels per CSS pixel), so `clickAt` can map back. */
  private shotScale = 1;
  private shotOrigin = { x: 0, y: 0 };

  /**
   * @param t - The connection to the tab.
   * @param painted - Runs a capture while the page is painted (the pane moves a hidden tab where it paints); default: as is.
   */
  constructor(
    private t: CdpTransport,
    private painted: <T>(fn: () => Promise<T>) => Promise<T> = (fn) => fn(),
  ) {
    this.off = t.onEvent((m, p) => this.event(m, p));
  }

  /** The tab's address and title now. */
  async where(): Promise<{ url: string; title: string }> {
    const h = (await this.t.send("Page.getNavigationHistory")) as { currentIndex: number; entries: Array<{ url: string; title: string }> };
    const e = h.entries[h.currentIndex];
    return { url: e?.url ?? "", title: e?.title ?? "" };
  }

  /** Turns on the events the buffers need. */
  async enable(): Promise<void> {
    await Promise.all(["Page.enable", "Runtime.enable", "Log.enable", "Network.enable"].map((m) => this.t.send(m).catch(() => undefined)));
  }

  /** Stops listening (the tab closed or the debugger detached). */
  dispose(): void {
    this.off();
    if (this.rec) clearTimeout(this.rec.timer);
    this.rec = undefined;
  }

  private event(method: string, p: Record<string, unknown>): void {
    switch (method) {
      case "Runtime.consoleAPICalled": {
        const args = (p.args as Array<{ value?: unknown; description?: string; type?: string }> | undefined) ?? [];
        const text = args.map((a) => (a.value !== undefined ? (typeof a.value === "string" ? a.value : JSON.stringify(a.value)) : a.description ?? a.type ?? "")).join(" ");
        const frame = (p.stackTrace as { callFrames?: Array<{ url: string; lineNumber: number }> } | undefined)?.callFrames?.[0];
        this.addConsole({ at: Date.now(), level: str(p.type) === "warning" ? "warn" : str(p.type) || "log", text, ...(frame?.url ? { where: `${redactUrl(frame.url)}:${frame.lineNumber + 1}` } : {}) });
        break;
      }
      case "Runtime.exceptionThrown": {
        const d = p.exceptionDetails as { text?: string; url?: string; lineNumber?: number; exception?: { description?: string } } | undefined;
        this.addConsole({ at: Date.now(), level: "error", text: d?.exception?.description ?? d?.text ?? "Uncaught error", ...(d?.url ? { where: `${redactUrl(d.url)}:${(d.lineNumber ?? 0) + 1}` } : {}) });
        break;
      }
      case "Log.entryAdded": {
        const e = p.entry as { level?: string; text?: string; url?: string } | undefined;
        if (e) this.addConsole({ at: Date.now(), level: e.level === "warning" ? "warn" : e.level ?? "log", text: str(e.text), ...(e.url ? { where: redactUrl(e.url) } : {}) });
        break;
      }
      case "Network.requestWillBeSent": {
        const r = p.request as { method?: string; url?: string; headers?: Record<string, unknown>; hasPostData?: boolean } | undefined;
        const id = str(p.requestId);
        const old = this.network.get(id);
        // A redirect reuses the id: the request keeps its number and gets the new address.
        const entry: NetworkEntry = { n: old?.n ?? this.nextRequest++, id, at: Date.now(), method: r?.method ?? "GET", url: r?.url ?? "", ...(p.type ? { type: str(p.type) } : {}), ...(r?.headers ? { requestHeaders: r.headers } : {}), ...(r?.hasPostData ? { hasPostData: true } : {}) };
        this.network.delete(id);
        this.network.set(id, entry);
        while (this.network.size > BUFFER) this.network.delete(this.network.keys().next().value!);
        break;
      }
      case "Network.responseReceived": {
        const e = this.network.get(str(p.requestId));
        const r = p.response as { status?: number; mimeType?: string; headers?: Record<string, unknown> } | undefined;
        if (e && r) Object.assign(e, { status: r.status, mimeType: r.mimeType, responseHeaders: r.headers });
        break;
      }
      case "Network.loadingFinished": {
        const e = this.network.get(str(p.requestId));
        if (e) e.size = Number(p.encodedDataLength ?? 0);
        break;
      }
      case "Network.loadingFailed": {
        const e = this.network.get(str(p.requestId));
        if (e) e.failed = str(p.errorText) || "failed";
        break;
      }
      case "Page.frameNavigated": {
        // A new page in the main frame: the old refs point at nothing.
        if (!(p.frame as { parentId?: string } | undefined)?.parentId) {
          this.refs.clear();
          this.labels.clear();
          this.userRefs.clear();
          this.dialog = undefined;
        }
        break;
      }
      case "Page.frameStartedLoading":
        this.loading = true;
        break;
      case "Page.frameStoppedLoading":
      case "Page.loadEventFired":
        this.loading = false;
        break;
      case "Page.javascriptDialogOpening":
        this.dialog = { type: str(p.type), message: str(p.message).slice(0, 2000), ...(p.defaultPrompt ? { defaultPrompt: str(p.defaultPrompt) } : {}) };
        break;
      case "Page.javascriptDialogClosed":
        this.dialog = undefined;
        break;
      case "Overlay.inspectNodeRequested":
        // The user picked an element on the page (the Debug drawer's "Pick"): keep it, and leave pick mode.
        this.picked = Number(p.backendNodeId);
        this.picking = false;
        void this.t.send("Overlay.setInspectMode", { mode: "none", highlightConfig: {} }).catch(() => undefined);
        break;
      case "Page.screencastFrame":
        void this.t.send("Page.screencastFrameAck", { sessionId: p.sessionId }).catch(() => undefined);
        if (this.rec && this.rec.frames.length < RECORD_FRAMES) this.rec.frames.push({ data: Buffer.from(str(p.data), "base64"), at: Date.now() });
        break;
    }
  }

  private addConsole(e: ConsoleEntry): void {
    this.console.push({ ...e, text: e.text.slice(0, 2000) });
    if (this.console.length > BUFFER) this.console.shift();
  }

  /** @throws Error while a pop-up waits: the page is frozen until it is answered. */
  private noDialog(): void {
    if (this.dialog) throw new Error(`The page shows a ${this.dialog.type} pop-up ("${this.dialog.message.slice(0, 200)}"). Answer it with browser_dialog first.`);
  }

  /** The DOM node of a ref, or a clear error when it is unknown or gone. */
  private node(ref: string): number {
    const id = this.refs.get(ref.trim());
    if (id === undefined) throw new Error(`There is no ref ${ref} on this page now. Take a new browser_snapshot and use its refs.`);
    return id;
  }

  /** Runs a DOM command on a ref's node; a node that left the page says to take a new snapshot. */
  private async onNode<T>(ref: string, fn: (backendNodeId: number) => Promise<T>): Promise<T> {
    const id = this.node(ref);
    try {
      return await fn(id);
    } catch (e) {
      const msg = (e as Error).message;
      if (/No node|not found|Could not compute|does not belong|detached/i.test(msg)) throw new Error(`Ref ${ref} is no longer on the page (it changed). Take a new browser_snapshot.`);
      throw e;
    }
  }

  /** The middle of a node on screen (CSS pixels of the visible area), after scrolling it into view. */
  private async center(backendNodeId: number): Promise<{ x: number; y: number }> {
    await this.t.send("DOM.scrollIntoViewIfNeeded", { backendNodeId }).catch(() => undefined);
    const { model } = (await this.t.send("DOM.getBoxModel", { backendNodeId })) as { model: { content: number[] } };
    const q = model.content;
    const x = (q[0]! + q[2]! + q[4]! + q[6]!) / 4;
    const y = (q[1]! + q[3]! + q[5]! + q[7]!) / 4;
    return { x: Math.round(x), y: Math.round(y) };
  }

  /** Waits a moment after an action, and for the page to load when it started loading. */
  private async settle(ms = 8000): Promise<void> {
    await sleep(300);
    const end = Date.now() + ms;
    while (this.loading && Date.now() < end) await sleep(100);
  }

  /**
   * The page as an accessibility tree, as text: one line per element ("- button \"Send\" [ref=e3]"), indented by
   * nesting; controls get refs for the other tools. Replaces the refs of earlier snapshots.
   *
   * @returns The tree, and the number of refs.
   */
  async snapshot(o: { forUser?: boolean } = {}): Promise<{ tree: string; refs: number }> {
    this.noDialog();
    const { nodes } = (await this.t.send("Accessibility.getFullAXTree")) as { nodes: AxNode[] };
    const byId = new Map(nodes.map((n) => [n.nodeId, n]));
    const root = nodes.find((n) => !n.parentId || !byId.has(n.parentId));
    // The user's Elements view keeps its own refs, so looking there never breaks the model's.
    const refs = o.forUser ? new Map<string, number>() : this.refs;
    const labels = o.forUser ? new Map<string, string>() : this.labels;
    refs.clear();
    labels.clear();
    const lines: string[] = [];
    let chars = 0;
    let cut = 0;
    let n = 0;
    const visit = (node: AxNode, depth: number) => {
      const role = str(node.role?.value);
      const name = str(node.name?.value).replace(/\s+/g, " ").trim();
      const print = !node.ignored && !SKIP.has(role) && !(role === "StaticText" && !name) && !(role === "image" && !name);
      if (print) {
        let line: string;
        if (role === "StaticText") line = `- text: ${name.slice(0, 300)}`;
        else {
          const props = (node.properties ?? []).filter((p) => SHOWN.includes(p.name) && p.value?.value !== undefined && p.value.value !== false && p.value.value !== "false").map((p) => (p.value.value === true ? p.name : `${p.name}=${str(p.value.value)}`));
          const value = str(node.value?.value).slice(0, 200);
          let ref = "";
          if (ACTIONABLE.has(role) && node.backendDOMNodeId !== undefined) {
            ref = `e${++n}`;
            refs.set(ref, node.backendDOMNodeId);
            labels.set(ref, `${role}${name ? ` "${name.slice(0, 80)}"` : ""}`);
          }
          line = `- ${role}${name ? ` "${name.slice(0, 200)}"` : ""}${props.length ? ` [${props.join(", ")}]` : ""}${ref ? ` [ref=${ref}]` : ""}${value && value !== name ? `: ${value}` : ""}`;
        }
        const indented = `${"  ".repeat(depth)}${line}`;
        if (lines.length < SNAPSHOT_LINES && chars + indented.length < SNAPSHOT_CHARS) {
          lines.push(indented);
          chars += indented.length + 1;
        } else cut++;
      }
      if (print && ACTIONABLE.has(role) && !CONTAINERS.has(role)) return;
      for (const c of node.childIds ?? []) {
        const child = byId.get(c);
        if (!child) continue;
        // A control's own text is in its name already, and so is text that only repeats a heading's name.
        if (print && str(child.role?.value) === "StaticText" && (ACTIONABLE.has(role) || str(child.name?.value).replace(/\s+/g, " ").trim() === name)) continue;
        visit(child, print ? depth + 1 : depth);
      }
    };
    if (root) visit(root, 0);
    if (o.forUser) this.userRefs = refs;
    if (cut) lines.push(`(${cut} more elements not shown: scroll or use browser_wait / browser_snapshot after narrowing down)`);
    return { tree: lines.join("\n") || "(the page has no readable content)", refs: n };
  }

  /** Clicks the middle of a ref's element, like a mouse. */
  async click(ref: string, opts: { double?: boolean; button?: "left" | "right" | "middle" } = {}): Promise<void> {
    this.noDialog();
    await this.onNode(ref, async (id) => {
      const { x, y } = await this.center(id);
      await this.mouse(x, y, opts.button ?? "left", opts.double ? 2 : 1);
    });
    await this.settle();
  }

  private async mouse(x: number, y: number, button: string, clicks: number): Promise<void> {
    await this.t.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    for (let i = 1; i <= clicks; i++) {
      await this.t.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button, clickCount: i });
      await this.t.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button, clickCount: i });
    }
  }

  /** Moves the mouse over a ref's element (menus that open on hover). */
  async hover(ref: string): Promise<void> {
    this.noDialog();
    await this.onNode(ref, async (id) => {
      const { x, y } = await this.center(id);
      await this.t.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    });
    await sleep(300);
  }

  /**
   * Clicks a point of the last screenshot (its pixels), for what has no ref (a canvas, a map).
   *
   * @param x - Across, in the picture's pixels.
   * @param y - Down, in the picture's pixels.
   */
  async clickAt(x: number, y: number): Promise<void> {
    this.noDialog();
    const cx = Math.round(x / this.shotScale - this.shotOrigin.x);
    const cy = Math.round(y / this.shotScale - this.shotOrigin.y);
    await this.mouse(cx, cy, "left", 1);
    await this.settle();
  }

  /** The attributes of a node, by name. */
  private async attributes(backendNodeId: number): Promise<{ tag: string; attrs: Record<string, string> }> {
    const { node } = (await this.t.send("DOM.describeNode", { backendNodeId })) as { node: { nodeName?: string; attributes?: string[] } };
    const attrs: Record<string, string> = {};
    const a = node.attributes ?? [];
    for (let i = 0; i + 1 < a.length; i += 2) attrs[a[i]!.toLowerCase()] = a[i + 1]!;
    return { tag: str(node.nodeName).toLowerCase(), attrs };
  }

  /** Calls a function with the node as `this` in the page. */
  private async callOn(backendNodeId: number, fn: string, args: unknown[] = []): Promise<unknown> {
    const { object } = (await this.t.send("DOM.resolveNode", { backendNodeId })) as { object: { objectId: string } };
    const r = (await this.t.send("Runtime.callFunctionOn", { objectId: object.objectId, functionDeclaration: fn, arguments: args.map((value) => ({ value })), returnByValue: true, awaitPromise: true })) as { result?: { value?: unknown }; exceptionDetails?: { exception?: { description?: string }; text?: string } };
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? "The page refused.");
    return r.result?.value;
  }

  /**
   * Types into a ref's field, replacing what is there. Never into a password, card or one-time-code field.
   *
   * @param ref - The field.
   * @param text - What to type.
   * @param submit - Presses Enter after.
   */
  async type(ref: string, text: string, submit = false): Promise<void> {
    this.noDialog();
    await this.onNode(ref, async (id) => {
      const { attrs } = await this.attributes(id);
      const auto = (attrs.autocomplete ?? "").toLowerCase();
      if (attrs.type?.toLowerCase() === "password" || /^cc-|one-time-code|current-password|new-password/.test(auto) || /card.?num|cvv|cvc|security.?code/i.test(`${attrs.name ?? ""} ${attrs.id ?? ""}`))
        throw new Error("This is a password, card or code field: KesherAI never types there. Ask the user to type it themselves.");
      await this.t.send("DOM.focus", { backendNodeId: id }).catch(() => undefined);
      // Select what is there, so the typing replaces it.
      await this.callOn(id, "function () { this.focus(); if (typeof this.select === 'function') this.select(); else if (this.isContentEditable) { const r = document.createRange(); r.selectNodeContents(this); const s = getSelection(); s.removeAllRanges(); s.addRange(r); } }");
      await this.t.send("Input.insertText", { text });
    });
    if (submit) await this.pressKey("Enter");
    else await sleep(150);
  }

  /**
   * Chooses options of a <select> by their value or their words.
   *
   * @returns The words of the options now chosen.
   */
  async select(ref: string, values: string[]): Promise<string[]> {
    this.noDialog();
    return this.onNode(ref, async (id) => {
      const { tag } = await this.attributes(id);
      if (tag !== "select") throw new Error(`Ref ${ref} is not a list box (<select>): click it, then click the option's ref.`);
      const chosen = (await this.callOn(
        id,
        `function (wanted) {
          const want = wanted.map((w) => String(w).trim().toLowerCase());
          let any = false;
          for (const o of this.options) {
            const hit = want.includes(o.value.toLowerCase()) || want.includes(o.label.trim().toLowerCase());
            if (this.multiple) o.selected = hit; else if (hit && !any) { o.selected = true; any = true; }
          }
          this.dispatchEvent(new Event("input", { bubbles: true }));
          this.dispatchEvent(new Event("change", { bubbles: true }));
          return [...this.selectedOptions].map((o) => o.label);
        }`,
        [values],
      )) as string[];
      if (!chosen.length) throw new Error("None of those options are in the list.");
      return chosen;
    });
  }

  /**
   * Scrolls a ref's element into view, or the page by screens.
   *
   * @param o - `ref`, or a direction and how many screens (default 1).
   */
  async scroll(o: { ref?: string; direction?: "up" | "down" | "left" | "right"; screens?: number }): Promise<void> {
    this.noDialog();
    if (o.ref) {
      await this.onNode(o.ref, (id) => this.t.send("DOM.scrollIntoViewIfNeeded", { backendNodeId: id }));
      return;
    }
    const { cssVisualViewport: v } = (await this.t.send("Page.getLayoutMetrics")) as { cssVisualViewport: { clientWidth: number; clientHeight: number } };
    const k = Math.min(10, Math.max(0.1, o.screens ?? 1));
    const dir = o.direction ?? "down";
    const deltaY = dir === "down" ? v.clientHeight * 0.8 * k : dir === "up" ? -v.clientHeight * 0.8 * k : 0;
    const deltaX = dir === "right" ? v.clientWidth * 0.8 * k : dir === "left" ? -v.clientWidth * 0.8 * k : 0;
    await this.t.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: Math.round(v.clientWidth / 2), y: Math.round(v.clientHeight / 2), deltaX, deltaY });
    await sleep(300);
  }

  /**
   * Presses a key or a combination, e.g. "Enter", "Escape", "Control+a", "Shift+Tab", "ArrowDown".
   *
   * @throws Error for a key it does not know.
   */
  async pressKey(combo: string): Promise<void> {
    this.noDialog();
    const parts = combo.split("+").map((p) => p.trim()).filter(Boolean);
    const name = parts.pop() ?? "";
    let modifiers = 0;
    for (const m of parts) {
      const bit = MODIFIERS[m[0]!.toUpperCase() + m.slice(1).toLowerCase()];
      if (bit === undefined) throw new Error(`Unknown modifier ${m}: use Control, Shift, Alt or Meta.`);
      modifiers |= bit;
    }
    const known = KEYS[name] ?? KEYS[name[0]?.toUpperCase() + name.slice(1)];
    let key: { key: string; code: string; keyCode: number; text?: string };
    if (known) key = { key: name === "Space" ? " " : name, ...known };
    else if ([...name].length === 1) {
      const up = name.toUpperCase();
      key = { key: name, code: /[A-Z]/.test(up) ? `Key${up}` : /\d/.test(name) ? `Digit${name}` : "", keyCode: up.charCodeAt(0), text: name };
    } else throw new Error(`Unknown key ${name}.`);
    // With Control, Alt or Meta the key is a shortcut, not text.
    const text = modifiers & 7 ? undefined : key.text;
    await this.t.send("Input.dispatchKeyEvent", { type: text ? "keyDown" : "rawKeyDown", key: key.key, code: key.code, windowsVirtualKeyCode: key.keyCode, modifiers, ...(text ? { text, unmodifiedText: text } : {}) });
    await this.t.send("Input.dispatchKeyEvent", { type: "keyUp", key: key.key, code: key.code, windowsVirtualKeyCode: key.keyCode, modifiers });
    await this.settle(name === "Enter" ? 8000 : 0);
  }

  /** Sends files to a file field (`<input type=file>`). The caller checks the paths (browser-safety.ts uploadRefusal). */
  async upload(ref: string, files: string[]): Promise<void> {
    this.noDialog();
    await this.onNode(ref, async (id) => {
      const { tag, attrs } = await this.attributes(id);
      if (tag !== "input" || attrs.type?.toLowerCase() !== "file") throw new Error(`Ref ${ref} is not a file field.`);
      await this.t.send("DOM.setFileInputFiles", { files, backendNodeId: id });
    });
  }

  /**
   * Waits until text shows on the page, or leaves it, or for a time.
   *
   * @param o - `text` to appear, `gone` to disappear, or only `ms`; `timeoutMs` at most 30 s (default 10 s).
   * @returns What happened, in words.
   */
  async waitFor(o: { text?: string; gone?: string; ms?: number; timeoutMs?: number }): Promise<string> {
    if (!o.text && !o.gone) {
      await sleep(Math.min(30_000, Math.max(0, o.ms ?? 1000)));
      return `Waited ${Math.round(Math.min(30_000, Math.max(0, o.ms ?? 1000)) / 100) / 10} s.`;
    }
    const end = Date.now() + Math.min(30_000, o.timeoutMs ?? 10_000);
    for (;;) {
      this.noDialog();
      const r = (await this.t.send("Runtime.evaluate", { expression: "document.body ? document.body.innerText : ''", returnByValue: true }).catch(() => undefined)) as { result?: { value?: unknown } } | undefined;
      const body = str(r?.result?.value);
      if (o.text && body.includes(o.text)) return `"${o.text}" is on the page.`;
      if (o.gone && !body.includes(o.gone)) return `"${o.gone}" is gone from the page.`;
      if (Date.now() > end) throw new Error(`Still ${o.text ? `no "${o.text}"` : `"${o.gone}" is there`} after ${Math.round((o.timeoutMs ?? 10_000) / 1000)} s.`);
      await sleep(250);
    }
  }

  /** Back, forward or reload. */
  async history(what: "back" | "forward" | "reload"): Promise<void> {
    this.noDialog();
    if (what === "reload") await this.t.send("Page.reload");
    else {
      const h = (await this.t.send("Page.getNavigationHistory")) as { currentIndex: number; entries: Array<{ id: number }> };
      const e = h.entries[h.currentIndex + (what === "back" ? -1 : 1)];
      if (!e) throw new Error(what === "back" ? "There is no page to go back to." : "There is no page to go forward to.");
      await this.t.send("Page.navigateToHistoryEntry", { entryId: e.id });
    }
    this.loading = true;
    await this.settle(15_000);
  }

  /** Answers the pop-up the page opened (OK / Cancel, and text for a prompt). */
  async answerDialog(accept: boolean, text?: string): Promise<string> {
    const d = this.dialog;
    if (!d) throw new Error("No pop-up is open.");
    await this.t.send("Page.handleJavaScriptDialog", { accept, ...(text !== undefined ? { promptText: text } : {}) });
    this.dialog = undefined;
    return `${accept ? "Accepted" : "Dismissed"} the ${d.type} "${d.message.slice(0, 200)}".`;
  }

  /**
   * Runs JavaScript in the page (the tool asks the user every time) and gives back its result as JSON.
   *
   * @param expression - An expression or an async function body's value.
   */
  async evaluate(expression: string): Promise<string> {
    this.noDialog();
    const r = (await this.t.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, userGesture: true, timeout: 10_000 })) as { result?: { value?: unknown; description?: string; type?: string }; exceptionDetails?: { exception?: { description?: string }; text?: string } };
    if (r.exceptionDetails) throw new Error(`The code failed: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? "error"}`.slice(0, 2000));
    const v = r.result?.value;
    const out = v === undefined ? r.result?.description ?? r.result?.type ?? "undefined" : typeof v === "string" ? v : JSON.stringify(v, null, 1);
    return out.length > 8000 ? `${out.slice(0, 8000)}\n(cut: ${out.length} characters)` : out;
  }

  /**
   * The console since the tab opened (or since the last clear).
   *
   * @param o - `errors`: only errors and warnings; `clear`: empty it after reading; `last`: how many (default 60).
   */
  consoleLines(o: { errors?: boolean; clear?: boolean; last?: number } = {}): ConsoleEntry[] {
    const list = this.console.filter((e) => !o.errors || e.level === "error" || e.level === "warn" || e.level === "assert");
    if (o.clear) this.console = [];
    return list.slice(-Math.min(BUFFER, Math.max(1, o.last ?? 60)));
  }

  /**
   * The network requests since the tab opened.
   *
   * @param o - `filter`: words in the address; `failed`: only failed ones and status ≥ 400; `last`: how many (default 60).
   */
  requests(o: { filter?: string; failed?: boolean; last?: number } = {}): NetworkEntry[] {
    const f = o.filter?.toLowerCase();
    return [...this.network.values()].filter((e) => (!f || e.url.toLowerCase().includes(f)) && (!o.failed || !!e.failed || (e.status ?? 0) >= 400)).slice(-Math.min(BUFFER, Math.max(1, o.last ?? 60)));
  }

  /**
   * One request in full: headers (sign-ins hidden), what was sent (secret fields hidden) and the answer's body (cut).
   *
   * @param n - Its number from `requests`.
   */
  async requestDetail(n: number): Promise<string> {
    const e = [...this.network.values()].find((x) => x.n === n);
    if (!e) throw new Error(`There is no request #${n} (it may be old). Look at browser_network again.`);
    const lines = [`#${e.n} ${e.method} ${redactUrl(e.url)}`, `Status: ${e.failed ? `failed (${e.failed})` : e.status ?? "no answer yet"}${e.mimeType ? ` · ${e.mimeType}` : ""}${e.size !== undefined ? ` · ${e.size} bytes` : ""}`];
    lines.push("", "Request headers:", ...Object.entries(redactHeaders(e.requestHeaders)).map(([k, v]) => `  ${k}: ${v}`));
    if (e.hasPostData) {
      const p = (await this.t.send("Network.getRequestPostData", { requestId: e.id }).catch(() => undefined)) as { postData?: string } | undefined;
      lines.push("", "Sent:", redactBody(p?.postData) || "(not available)");
    }
    if (e.responseHeaders) lines.push("", "Answer headers:", ...Object.entries(redactHeaders(e.responseHeaders)).map(([k, v]) => `  ${k}: ${v}`));
    if (e.status !== undefined && !e.failed) {
      const b = (await this.t.send("Network.getResponseBody", { requestId: e.id }).catch(() => undefined)) as { body?: string; base64Encoded?: boolean } | undefined;
      if (!b) lines.push("", "Answer: (not kept by the browser)");
      else if (b.base64Encoded) lines.push("", `Answer: (binary, about ${Math.round((b.body?.length ?? 0) * 0.75)} bytes)`);
      else lines.push("", "Answer:", redactBody(b.body) || "(empty)");
    }
    return lines.join("\n");
  }

  /**
   * A picture of the visible area, the whole page or one element, as PNG, in CSS pixels (at most 1600 wide).
   *
   * @param o - `full` for the whole page, `ref` for one element, or `area` for a part of the last picture of the
   *   visible area (in its pixels: the approval card's crop around a point, vision search's look).
   */
  async screenshot(o: { full?: boolean; ref?: string; area?: { x: number; y: number; width: number; height: number } } = {}): Promise<{ data: Buffer; width: number; height: number }> {
    this.noDialog();
    const m = (await this.t.send("Page.getLayoutMetrics")) as { cssVisualViewport: { pageX: number; pageY: number; clientWidth: number; clientHeight: number }; cssContentSize?: { width: number; height: number } };
    const v = m.cssVisualViewport;
    let clip = { x: v.pageX, y: v.pageY, width: v.clientWidth, height: v.clientHeight };
    if (o.ref) {
      clip = await this.onNode(o.ref, async (id) => {
        await this.t.send("DOM.scrollIntoViewIfNeeded", { backendNodeId: id }).catch(() => undefined);
        const { model } = (await this.t.send("DOM.getBoxModel", { backendNodeId: id })) as { model: { border: number[] } };
        const q = model.border;
        const xs = [q[0]!, q[2]!, q[4]!, q[6]!];
        const ys = [q[1]!, q[3]!, q[5]!, q[7]!];
        const after = (await this.t.send("Page.getLayoutMetrics")) as typeof m;
        // The box is in the visible area's pixels; the clip is in the page's.
        return { x: Math.min(...xs) + after.cssVisualViewport.pageX, y: Math.min(...ys) + after.cssVisualViewport.pageY, width: Math.max(1, Math.max(...xs) - Math.min(...xs)), height: Math.max(1, Math.max(...ys) - Math.min(...ys)) };
      });
    } else if (o.full && m.cssContentSize) clip = { x: 0, y: 0, width: m.cssContentSize.width, height: Math.min(m.cssContentSize.height, 12_000) };
    else if (o.area) {
      const k = this.shotScale || 1;
      const x = Math.max(0, o.area.x / k - this.shotOrigin.x);
      const y = Math.max(0, o.area.y / k - this.shotOrigin.y);
      clip = { x: x + v.pageX, y: y + v.pageY, width: Math.max(1, Math.min(o.area.width / k, v.clientWidth - x)), height: Math.max(1, Math.min(o.area.height / k, v.clientHeight - y)) };
    }
    const scale = Math.min(1, 1600 / Math.max(1, clip.width));
    const r = (await this.painted(() => this.t.send("Page.captureScreenshot", { format: "png", clip: { ...clip, scale }, captureBeyondViewport: !!o.full || !!o.ref }))) as { data: string };
    // Only a picture of the visible area maps back to clicks.
    if (!o.full && !o.ref && !o.area) {
      this.shotScale = scale;
      this.shotOrigin = { x: 0, y: 0 };
    }
    return { data: Buffer.from(r.data, "base64"), width: Math.round(clip.width * scale), height: Math.round(clip.height * scale) };
  }

  /** Turns on what highlighting and picking need (once per tab). */
  private overlayOn = false;
  private async overlay(): Promise<void> {
    if (this.overlayOn) return;
    await this.t.send("DOM.enable").catch(() => undefined);
    await this.t.send("Overlay.enable").catch(() => undefined);
    this.overlayOn = true;
  }

  /**
   * Describes one element: tag, attributes, box, the styles that matter, its text and HTML, and whether its content is
   * cut. Secret-looking attribute values are hidden. With `highlight`, the page shows it (the Debug drawer).
   *
   * @param at - A ref (the model's, or the user's Elements view's with `user`), a point of the last screenshot
   *   (`x`, `y` in its pixels), a point as a fraction of the visible area (`fx`, `fy`: a tap on the phone's picture),
   *   or the element the user `picked`.
   * @throws Error when there is no such element.
   */
  async inspect(at: { ref?: string; user?: boolean; x?: number; y?: number; fx?: number; fy?: number; picked?: boolean; highlight?: boolean }): Promise<InspectInfo> {
    this.noDialog();
    let id: number | undefined;
    if (at.ref) {
      id = (at.user ? this.userRefs : this.refs).get(at.ref.trim());
      if (id === undefined) throw new Error(`There is no ref ${at.ref} on this page now. Take a new browser_snapshot and use its refs.`);
    } else if (at.picked) {
      id = this.picked;
      if (id === undefined) throw new Error("No element was picked on the page.");
    } else {
      let x: number;
      let y: number;
      if (at.fx !== undefined && at.fy !== undefined) {
        const { cssVisualViewport: v } = (await this.t.send("Page.getLayoutMetrics")) as { cssVisualViewport: { clientWidth: number; clientHeight: number } };
        x = Math.round(Math.min(1, Math.max(0, at.fx)) * v.clientWidth);
        y = Math.round(Math.min(1, Math.max(0, at.fy)) * v.clientHeight);
      } else {
        x = Math.round(Number(at.x) / this.shotScale - this.shotOrigin.x);
        y = Math.round(Number(at.y) / this.shotScale - this.shotOrigin.y);
      }
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("Give a ref, or x and y of the last screenshot.");
      const r = (await this.t.send("DOM.getNodeForLocation", { x, y, ignorePointerEventsNone: true })) as { backendNodeId?: number };
      id = r.backendNodeId;
      if (id === undefined) throw new Error("There is no element at that point.");
    }
    const backendNodeId = id;
    const info = (await this.callOn(
      backendNodeId,
      `function (names) {
        let el = this.nodeType === 1 ? this : this.parentElement;
        if (!el) return null;
        const secret = /pass|token|secret|csrf|auth|session|key|otp|card|cvv|cvc/i;
        const pw = el.tagName === "INPUT" && /password/i.test(el.type || "");
        const attributes = {};
        for (const a of el.attributes) attributes[a.name] = (secret.test(a.name) || (pw && a.name === "value")) ? "(hidden)" : a.value.slice(0, 300);
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        const styles = {};
        for (const n of names) { const v = cs.getPropertyValue(n); if (v && v !== "none" && v !== "normal" && v !== "auto" && v !== "0px") styles[n] = v; }
        const clipsX = cs.overflowX !== "visible" || cs.textOverflow === "ellipsis";
        const clipsY = cs.overflowY !== "visible";
        const cut = (clipsX && el.scrollWidth > el.clientWidth + 1) || (clipsY && el.scrollHeight > el.clientHeight + 1 && cs.overflowY !== "auto" && cs.overflowY !== "scroll");
        let html = el.outerHTML;
        if (pw) html = html.replace(/\\svalue="[^"]*"/gi, ' value="(hidden)"');
        html = html.replace(/(\\s(?:[\\w-]*(?:pass|token|secret|csrf|auth|session|key|otp|card|cvv|cvc)[\\w-]*)=")[^"]*"/gi, '$1(hidden)"');
        return { tag: el.tagName.toLowerCase(), attributes, box: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) }, styles, text: pw ? "" : (el.innerText || el.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 300), html: html.slice(0, 1500), cut };
      }`,
      [INSPECT_STYLES],
    )) as InspectInfo | null;
    if (!info) throw new Error("That is not an element.");
    if (at.highlight) {
      await this.overlay();
      await this.t.send("Overlay.highlightNode", { backendNodeId, highlightConfig: { showInfo: true, contentColor: { r: 111, g: 168, b: 220, a: 0.45 }, paddingColor: { r: 147, g: 196, b: 125, a: 0.4 }, marginColor: { r: 246, g: 178, b: 107, a: 0.4 } } }).catch(() => undefined);
    }
    return info;
  }

  /**
   * Pick mode (the Debug drawer on the computer): the next element the user clicks on the page is kept as `picked`
   * instead of being clicked.
   */
  async pick(on: boolean): Promise<void> {
    await this.overlay();
    if (on) this.picked = undefined;
    await this.t.send("Overlay.setInspectMode", { mode: on ? "searchForNode" : "none", highlightConfig: { showInfo: true, contentColor: { r: 111, g: 168, b: 220, a: 0.45 } } });
    this.picking = on;
  }

  /**
   * Shows the page as a 390 px phone, a 1280 px desktop or at the pane's own size, and in dark or light colors.
   *
   * @param o - What to change; the rest stays.
   * @returns How the page is shown now.
   */
  async emulate(o: Partial<Emulation>): Promise<Emulation> {
    const next: Emulation = { ...this.emulation, ...o };
    if (o.device !== undefined) {
      if (next.device === "none") await this.t.send("Emulation.clearDeviceMetricsOverride");
      else {
        const v = next.device === "phone" ? PHONE_VIEW : DESKTOP_VIEW;
        await this.t.send("Emulation.setDeviceMetricsOverride", { ...v, deviceScaleFactor: 1, mobile: next.device === "phone" });
      }
      await this.t.send("Emulation.setTouchEmulationEnabled", { enabled: next.device === "phone", ...(next.device === "phone" ? { maxTouchPoints: 5 } : {}) }).catch(() => undefined);
    }
    if (o.scheme !== undefined) await this.t.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: next.scheme === "auto" ? "" : next.scheme }] });
    this.emulation = next;
    return next;
  }

  /**
   * "Try my change": reloads the page, then gathers what went wrong since (console errors and warnings, failed
   * requests) and pictures of it at 390 px and on a desktop, with how far each is wider than its view. The page's
   * own view is put back after.
   */
  async tryChange(): Promise<TryResult> {
    const since = Date.now();
    const before = this.emulation;
    await this.history("reload");
    await sleep(700);
    const errors = this.console.filter((e) => e.at >= since && (e.level === "error" || e.level === "warn" || e.level === "assert"));
    const failed = [...this.network.values()].filter((e) => e.at >= since && (!!e.failed || (e.status ?? 0) >= 400));
    const views: TryResult["views"] = [];
    try {
      for (const device of ["phone", "desktop"] as const) {
        await this.emulate({ device });
        await sleep(400);
        // Against the screen's width, not innerWidth: a phone's page widens its layout to fit content that is too wide.
        const width = device === "phone" ? PHONE_VIEW.width : DESKTOP_VIEW.width;
        const r = (await this.t.send("Runtime.evaluate", { expression: `Math.max(0, document.documentElement.scrollWidth - ${width})`, returnByValue: true }).catch(() => undefined)) as { result?: { value?: unknown } } | undefined;
        const shot = await this.screenshot();
        views.push({ device, ...shot, overflow: Number(r?.result?.value ?? 0) || 0 });
      }
    } finally {
      await this.emulate({ device: before.device }).catch(() => undefined);
    }
    return { url: (await this.where()).url, errors, failed, views };
  }

  /** Whether a recording runs now. */
  get recording(): boolean {
    return !!this.rec;
  }

  /**
   * Starts recording the tab (pictures each time it changes, up to 300 frames or 60 seconds, then it stops by itself).
   * Stop with `stopRecording`, which gives the frames for a GIF or a WebM (browser-record.ts).
   */
  async startRecording(): Promise<void> {
    if (this.rec) throw new Error("A recording is already running: stop it first.");
    const timer = setTimeout(() => void this.t.send("Page.stopScreencast").catch(() => undefined), RECORD_MS);
    this.rec = { frames: [], started: Date.now(), timer };
    try {
      await this.t.send("Page.startScreencast", { format: "png", maxWidth: 800, maxHeight: 800, everyNthFrame: 1 });
    } catch (e) {
      clearTimeout(timer);
      this.rec = undefined;
      throw e;
    }
  }

  /**
   * Stops the recording and gives its frames, with a last picture of the page as it is now.
   *
   * @throws Error when no recording runs.
   */
  async stopRecording(): Promise<RecordedFrame[]> {
    const rec = this.rec;
    if (!rec) throw new Error("No recording is running.");
    this.rec = undefined;
    clearTimeout(rec.timer);
    await this.t.send("Page.stopScreencast").catch(() => undefined);
    const last = await this.screenshot().catch(() => undefined);
    if (last) rec.frames.push({ data: last.data, at: Date.now() });
    return rec.frames;
  }
}

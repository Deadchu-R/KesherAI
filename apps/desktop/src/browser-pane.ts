/**
 * KesherAI's own browser pane: real web pages shown inside the app window, next to a chat, that the
 * model can read and act on while the user watches (like Claude's browser pane).
 *
 * - Each tab is a `WebContentsView` in its own storage ("persist:kesher-browser"): it never shares
 *   cookies or storage with KesherAI's own pages, and has no preload, no Node, sandboxed.
 * - The web UI draws the address bar and tabs, and tells this file where the page area is
 *   (`setBounds`); the view is laid over that area. Nothing is shown while the area is hidden.
 * - The model's commands (tabs, open, read, click, type, screenshot) are the same as the browser
 *   extension's, and run the same page helpers (browser-extension/page.js), so both act alike.
 * - Never: KesherAI's own address, files on the computer, downloads (refused, the user is told),
 *   camera / microphone / location (refused).
 */
import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { BaseWindow, type BrowserWindow, WebContentsView, session, shell } from "electron";

export interface PaneTab {
  id: number;
  title: string;
  url: string;
  active: boolean;
  loading: boolean;
  canBack: boolean;
  canForward: boolean;
}

interface Tab {
  id: number;
  view: WebContentsView;
}

const PARTITION = "persist:kesher-browser";

/** The page helpers shared with the extension (readPage, clickRef, typeRef), as source text. */
function pageHelpers(): string {
  const resources = (process as { resourcesPath?: string }).resourcesPath;
  const file = [resources && join(resources, "browser-extension", "page.js"), resolve(import.meta.dirname, "../../browser-extension/page.js")].find(
    (p): p is string => !!p && existsSync(p),
  );
  if (!file) throw new Error("The browser pane's page helpers are missing from this copy of KesherAI.");
  return readFileSync(file, "utf8");
}

/** Whether the pane may open an address: web pages only, never KesherAI itself. */
export function paneAllows(url: string, ownPort: number): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return url === "about:blank";
  const own = ["127.0.0.1", "localhost", "[::1]", "0.0.0.0"].includes(u.hostname) && Number(u.port || (u.protocol === "https:" ? 443 : 80)) === ownPort;
  return !own;
}

/** Turns what the user typed in the address bar into an address (a search when it is not one). */
export function addressFrom(text: string): string {
  const t = text.trim();
  if (/^https?:\/\//i.test(t) || t === "about:blank") return t;
  if (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(t)) return `http://${t}`;
  if (/^[^\s/]+\.[a-z]{2,}(:\d+)?(\/\S*)?$/i.test(t)) return `https://${t}`;
  return `https://duckduckgo.com/?q=${encodeURIComponent(t)}`;
}

/** The browser pane of one window: its tabs, where they are drawn, and the model's commands (see the top of this file). */
export class BrowserPane {
  private tabs: Tab[] = [];
  private active = 0;
  private nextId = 1;
  private bounds: Electron.Rectangle | null = null;
  private helpers: string | undefined;

  /**
   * @param win - The app window the pane is drawn in.
   * @param ownPort - KesherAI's own port (never opened in the pane).
   * @param changed - Called with the tabs whenever something changes (for the web UI).
   */
  constructor(
    private win: BrowserWindow,
    private ownPort: number,
    private changed: (tabs: PaneTab[]) => void,
  ) {
    const ses = session.fromPartition(PARTITION);
    ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    ses.setPermissionCheckHandler(() => false);
    ses.on("will-download", (event, item) => {
      event.preventDefault();
      this.notice = `A download was stopped: ${item.getFilename()}. KesherAI's browser does not download files.`;
      this.emit();
    });
  }

  /** A short message for the web UI (a stopped download). */
  notice = "";

  /** The tabs, for the web UI and the model. */
  list(): PaneTab[] {
    return this.tabs.map((t) => {
      const wc = t.view.webContents;
      return {
        id: t.id,
        title: wc.getTitle() || "New tab",
        url: wc.getURL(),
        active: t.id === this.active,
        loading: wc.isLoading(),
        canBack: wc.navigationHistory.canGoBack(),
        canForward: wc.navigationHistory.canGoForward(),
      };
    });
  }

  private emit(): void {
    this.changed(this.list());
  }

  private tab(id?: unknown): Tab {
    const t = typeof id === "number" ? this.tabs.find((x) => x.id === id) : this.tabs.find((x) => x.id === this.active);
    if (!t) throw new Error(typeof id === "number" ? `There is no tab ${id}.` : "No tab is open in KesherAI's browser.");
    return t;
  }

  /** Where the web UI shows the page (window coordinates), or null to hide it. */
  setBounds(b: Electron.Rectangle | null): void {
    this.bounds = b && b.width > 20 && b.height > 20 ? { x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) } : null;
    this.layout();
  }

  private layout(): void {
    for (const t of this.tabs) {
      const show = !!this.bounds && t.id === this.active;
      if (show) {
        if (!this.win.contentView.children.includes(t.view)) this.win.contentView.addChildView(t.view);
        t.view.setBounds(this.bounds!);
        t.view.setVisible(true);
      } else if (this.win.contentView.children.includes(t.view)) {
        this.win.contentView.removeChildView(t.view);
      }
    }
  }

  /** Opens a new tab (in front) at an address. */
  newTab(url = "about:blank"): Tab {
    const view = new WebContentsView({
      webPreferences: { partition: PARTITION, contextIsolation: true, sandbox: true, nodeIntegration: false, webviewTag: false, safeDialogs: true },
    });
    const tab: Tab = { id: this.nextId++, view };
    const wc = view.webContents;
    // Links that open a new window open a new tab here instead; other schemes (mailto:) go to the system.
    wc.setWindowOpenHandler(({ url: to }) => {
      if (paneAllows(to, this.ownPort)) void this.open(to, undefined, true);
      else if (/^mailto:/i.test(to)) void shell.openExternal(to);
      return { action: "deny" };
    });
    const guard = (event: Electron.Event, to: string) => {
      if (!paneAllows(to, this.ownPort)) event.preventDefault();
    };
    wc.on("will-navigate", guard);
    wc.on("will-redirect", guard);
    wc.on("will-attach-webview", (event) => event.preventDefault());
    for (const ev of ["did-start-loading", "did-stop-loading", "page-title-updated", "did-navigate", "did-navigate-in-page"] as const) wc.on(ev as "did-start-loading", () => this.emit());
    this.tabs.push(tab);
    this.active = tab.id;
    this.layout();
    if (url !== "about:blank") void wc.loadURL(url).catch(() => undefined);
    this.emit();
    return tab;
  }

  /** Brings a tab to the front. */
  select(id: number): void {
    this.tab(id);
    this.active = id;
    this.layout();
    this.emit();
  }

  /** Closes a tab. */
  close(id: number): void {
    const i = this.tabs.findIndex((t) => t.id === id);
    if (i < 0) return;
    const [t] = this.tabs.splice(i, 1);
    if (this.win.contentView.children.includes(t!.view)) this.win.contentView.removeChildView(t!.view);
    t!.view.webContents.close();
    if (this.active === id) this.active = this.tabs[Math.max(0, i - 1)]?.id ?? 0;
    this.layout();
    this.emit();
  }

  /** Back, forward, reload or stop in the tab in front. */
  nav(what: "back" | "forward" | "reload" | "stop"): void {
    const t = this.tabs.find((x) => x.id === this.active);
    if (!t) return;
    const wc = t.view.webContents;
    if (what === "back") wc.navigationHistory.goBack();
    else if (what === "forward") wc.navigationHistory.goForward();
    else if (what === "reload") wc.reload();
    else wc.stop();
  }

  /**
   * Opens an address (what the user typed, or the model's), in a tab or a new one.
   *
   * @returns The tab it opened in.
   */
  async open(text: string, tabId?: number, newTab = false): Promise<Tab> {
    const url = addressFrom(text);
    if (!paneAllows(url, this.ownPort)) throw new Error("KesherAI's browser opens web pages only (http and https), not KesherAI itself or files.");
    const t = newTab || !this.tabs.length ? this.newTab() : this.tab(tabId);
    this.active = t.id;
    this.layout();
    await t.view.webContents.loadURL(url).catch(() => undefined);
    this.emit();
    return t;
  }

  private async inPage(t: Tab, call: string): Promise<unknown> {
    this.helpers ??= pageHelpers();
    // An isolated world: the page's own scripts cannot see or change the helpers.
    const out = (await t.view.webContents.executeJavaScriptInIsolatedWorld(1001, [{ code: `(() => {\n${this.helpers}\nreturn ${call};\n})()` }], true)) as unknown;
    if (out && typeof out === "object" && "error" in out && Object.keys(out).length === 1) throw new Error(String((out as { error: unknown }).error));
    return out;
  }

  private async settle(t: Tab, ms: number): Promise<void> {
    const wc = t.view.webContents;
    await new Promise((r) => setTimeout(r, 300));
    if (!wc.isLoading()) return;
    await new Promise<void>((r) => {
      const timer = setTimeout(r, ms);
      wc.once("did-stop-loading", () => {
        clearTimeout(timer);
        r();
      });
    });
  }

  /** One command from the model (the same commands as the browser extension). */
  async run(action: string, a: Record<string, unknown>): Promise<unknown> {
    if (action === "tabs") return this.list().map(({ id, title, url, active }) => ({ id, title, url, active }));
    if (action === "open") {
      const t = await this.open(String(a.url ?? ""), typeof a.tabId === "number" ? a.tabId : undefined, typeof a.tabId !== "number");
      await this.settle(t, 20_000);
      return this.inPage(t, "readPage()");
    }
    if (action === "fab-search") return this.fabSearch(String(a.path ?? ""));
    if (action === "moodle") return this.moodle(a);
    if (action === "stremio") return this.stremio(String(a.op ?? ""));
    if (action === "site-cookies") return this.siteCookies(String(a.url ?? ""));
    const t = this.tab(a.tabId);
    if (action === "read") return this.inPage(t, "readPage()");
    if (action === "click") {
      await this.inPage(t, `clickRef(${JSON.stringify(Number(a.ref))})`);
      await new Promise((r) => setTimeout(r, 800));
      await this.settle(t, 8000);
      return this.inPage(t, "readPage()");
    }
    if (action === "type") {
      await this.inPage(t, `typeRef(${JSON.stringify(Number(a.ref))}, ${JSON.stringify(String(a.text ?? ""))}, ${a.submit ? "true" : "false"})`);
      await new Promise((r) => setTimeout(r, a.submit ? 1200 : 300));
      if (a.submit) await this.settle(t, 8000);
      return this.inPage(t, "readPage()");
    }
    if (action === "screenshot") {
      if (t.id !== this.active) this.select(t.id);
      const img = await this.picture(t);
      if (img.isEmpty()) throw new Error("The page could not be pictured; open the Browser pane beside the chat and try again.");
      return { dataUrl: img.toDataURL() };
    }
    throw new Error(`Unknown action ${action}`);
  }

  /**
   * Fab's own search, run inside a fab.com tab (the user's Fab sign-in; Fab has no public API and answers only a real
   * browser). Only its search route; a fab.com tab is opened when there is none.
   */
  /**
   * The student's Moodle, read with her own sign-in in a tab on its address (RESEARCH_LOG "Students, part 19"): the
   * page's own AJAX service (`lib/ajax/service.php` with the session key from her dashboard), a course page, or one
   * file. Read only: only these GETs and the listed read methods; nothing is posted, submitted or changed.
   */
  private async moodle(a: Record<string, unknown>): Promise<unknown> {
    const base = String(a.base ?? "").replace(/\/+$/, "");
    if (!/^https:\/\/[\w.-]+(:\d+)?(\/[\w.-]+)*$/.test(base)) throw new Error("A Moodle address like https://moodle.university.ac.il");
    const op = String(a.op ?? "");
    const host = new URL(base).host;
    let t = this.tabs.find((x) => { try { return new URL(x.view.webContents.getURL()).host === host; } catch { return false; } });
    if (!t || op === "signin") {
      t = await this.open(`${base}/my/`, undefined, true);
      await this.settle(t, 20_000);
      if (op === "signin") return { opened: true };
    }
    const run = (code: string) => t!.view.webContents.executeJavaScriptInIsolatedWorld(1002, [{ code }], true) as Promise<unknown>;
    if (op === "call") {
      const READ = /^(core_course_get_enrolled_courses_by_timeline_classification|core_calendar_get_action_events_by_timesort|core_webservice_get_site_info)$/;
      const calls = (Array.isArray(a.calls) ? a.calls : []).slice(0, 5) as Array<{ methodname?: unknown; args?: unknown }>;
      if (!calls.length || calls.some((c) => !READ.test(String(c.methodname)))) throw new Error("Only Moodle's read methods.");
      const body = JSON.stringify(calls.map((c, index) => ({ index, methodname: String(c.methodname), args: c.args ?? {} })));
      return run(`(async () => {
        const home = await fetch(${JSON.stringify(`${base}/my/`)}, { credentials: "include" });
        const html = await home.text();
        const key = /"sesskey":"(\\w+)"/.exec(html)?.[1];
        if (!key || /login\\/index\\.php/.test(home.url)) return { signedIn: false };
        const r = await fetch(${JSON.stringify(`${base}/lib/ajax/service.php?sesskey=`)} + key, { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: ${JSON.stringify(body)} });
        return { signedIn: true, answers: await r.json() };
      })()`);
    }
    if (op === "page") {
      const path = String(a.path ?? "");
      if (!/^\/course\/view\.php\?id=\d+$/.test(path)) throw new Error("Only a course page.");
      return run(`fetch(${JSON.stringify(base + path)}, { credentials: "include" }).then(async (r) => ({ status: r.status, url: r.url, html: (await r.text()).slice(0, 3000000) }))`);
    }
    if (op === "file") {
      const url = String(a.url ?? "");
      if (!url.startsWith(`${base}/`) || !/\/(mod\/resource\/view\.php\?id=\d+|pluginfile\.php\/)/.test(url)) throw new Error("Only a course file.");
      return run(`fetch(${JSON.stringify(url)}, { credentials: "include" }).then(async (r) => {
        const type = r.headers.get("content-type") || "";
        const name = decodeURIComponent((/filename\\*?=(?:UTF-8'')?"?([^";]+)/i.exec(r.headers.get("content-disposition") || "") || [])[1] || r.url.split("?")[0].split("/").pop() || "file");
        if (type.includes("text/html")) return { status: r.status, html: true, url: r.url };
        const buf = new Uint8Array(await r.arrayBuffer());
        if (buf.length > 60 * 1024 * 1024) return { status: 413, name };
        let bin = "";
        for (let i = 0; i < buf.length; i += 32768) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 32768));
        return { status: r.status, name, type, data: btoa(bin) };
      })`);
    }
    throw new Error("Unknown Moodle step.");
  }

  /**
   * Her sign-in cookies for one video site, as a Netscape cookies file's text, so yt-dlp can fetch a lecture video she
   * can see there (Panopto, Kaltura, Vimeo…: RESEARCH_LOG "Students, part 21"). Only the cookies of that site's own
   * domain, only https, asked for on her click; the caller writes them to a temporary file and removes it after.
   */
  private async siteCookies(url: string): Promise<string> {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      throw new Error("A video link.");
    }
    if (u.protocol !== "https:") throw new Error("Only https video links.");
    // The site's registrable part (panopto.tau.ac.il → tau.ac.il keeps its sign-in cookies, which often sit on the university's domain).
    const parts = u.hostname.split(".");
    const base = parts.slice(-(parts.at(-2)!.length <= 3 && parts.length > 2 ? 3 : 2)).join(".");
    const all = await session.fromPartition(PARTITION).cookies.get({});
    const mine = all.filter((c) => {
      const d = (c.domain ?? "").replace(/^\./, "");
      return d === u.hostname || u.hostname.endsWith(`.${d}`) || d.endsWith(`.${base}`) || d === base;
    });
    return ["# Netscape HTTP Cookie File", ...mine.map((c) => [c.domain?.startsWith(".") ? c.domain : (c.hostOnly ? c.domain : `.${c.domain}`), c.hostOnly ? "FALSE" : "TRUE", c.path ?? "/", c.secure ? "TRUE" : "FALSE", String(Math.floor(c.expirationDate ?? 0)), c.name, c.value].join("\t"))].join("\n");
  }

  /**
   * Stremio's own sign-in page (web.stremio.com) in a tab, so she signs in there however she likes (Google, Facebook,
   * email); then only the session key Stremio's page keeps (`localStorage.profile.auth.key`) is read back. Nothing else
   * of the page is read, and nothing is typed or clicked.
   */
  private async stremio(op: string): Promise<{ opened?: boolean; key?: string | null }> {
    const isStremio = (x: Tab) => {
      try {
        return new URL(x.view.webContents.getURL()).origin === "https://web.stremio.com";
      } catch {
        return false;
      }
    };
    if (op === "signin") {
      await this.open("https://web.stremio.com/#/intro?form=login", undefined, true);
      return { opened: true };
    }
    const t = this.tabs.find(isStremio);
    if (!t) return { key: null };
    const code = `(() => { try { const p = JSON.parse(localStorage.getItem("profile") || "null"); const k = p && p.auth && p.auth.key; return typeof k === "string" ? k : null; } catch { return null; } })()`;
    const key = (await t.view.webContents.executeJavaScriptInIsolatedWorld(1003, [{ code }], true)) as unknown;
    return { key: typeof key === "string" && /^[\w+/=-]{10,200}$/.test(key) ? key : null };
  }

  /** The fab.com tab KesherAI opened for searching, and when it closes. */
  private fabTab?: number;
  private fabTimer?: ReturnType<typeof setTimeout>;

  private async fabSearch(path: string): Promise<{ status: number; json?: unknown }> {
    if (!/^\/i\/listings\/search\?[\w%.=&+-]*$/.test(path)) throw new Error("Only Fab's listing search.");
    let t = this.tabs.find((x) => /^https:\/\/www\.fab\.com\//.test(x.view.webContents.getURL()));
    if (!t) {
      t = await this.open("https://www.fab.com/", undefined, true);
      this.fabTab = t.id;
      await this.settle(t, 20_000);
    }
    // A tab KesherAI opened for the search closes by itself two minutes after the last search (kept for the next ones).
    if (this.fabTab === t.id) {
      clearTimeout(this.fabTimer);
      this.fabTimer = setTimeout(() => {
        if (this.fabTab !== undefined && this.tabs.some((x) => x.id === this.fabTab)) this.close(this.fabTab);
        this.fabTab = undefined;
      }, 120_000);
    }
    const code = `fetch(${JSON.stringify(path)}, { credentials: "include", headers: { accept: "application/json" } }).then(async (r) => ({ status: r.status, json: r.ok && (r.headers.get("content-type") || "").includes("json") ? await r.json() : undefined }), () => ({ status: 0 }))`;
    return (await t.view.webContents.executeJavaScriptInIsolatedWorld(1001, [{ code }], true)) as { status: number; json?: unknown };
  }

  /**
   * A picture of a tab, also while it is not on screen (the pane closed on the computer, the phone looking):
   * Electron paints only a page laid out in a shown window, so a hidden tab is pictured in an off-screen window.
   */
  private async picture(t: Tab): Promise<Electron.NativeImage> {
    const wc = t.view.webContents;
    const shown = !!this.bounds && t.id === this.active && this.win.contentView.children.includes(t.view);
    if (shown) return wc.capturePage();
    // Tested in Electron 33: a page outside the window or under KesherAI's page is clipped or shows over it, and a
    // hidden window paints nothing. A window placed off the screen (shown, never focused, not in the taskbar or
    // Alt+Tab) paints, so the tab is moved there for the picture and back again.
    const width = this.bounds?.width ?? 1280;
    const height = this.bounds?.height ?? 800;
    const helper = this.helperWindow(width, height);
    if (this.win.contentView.children.includes(t.view)) this.win.contentView.removeChildView(t.view);
    helper.contentView.addChildView(t.view);
    t.view.setBounds({ x: 0, y: 0, width, height });
    t.view.setVisible(true);
    try {
      await new Promise((r) => setTimeout(r, 400));
      return await wc.capturePage(undefined, { stayHidden: true });
    } finally {
      if (!helper.isDestroyed()) helper.contentView.removeChildView(t.view);
      this.layout();
    }
  }

  private helper: BaseWindow | undefined;

  private helperWindow(width: number, height: number): BaseWindow {
    if (!this.helper || this.helper.isDestroyed()) {
      this.helper = new BaseWindow({ show: false, x: -20000, y: -20000, width, height, frame: false, skipTaskbar: true, focusable: false, ...(process.platform === "win32" ? { type: "toolbar" } : {}) });
      this.helper.showInactive();
    } else this.helper.setBounds({ x: -20000, y: -20000, width, height });
    return this.helper;
  }

  /** A picture of the tab in front (for the phone), as JPEG. */
  async shot(): Promise<Buffer | null> {
    const t = this.tabs.find((x) => x.id === this.active);
    if (!t) return null;
    const img = await this.picture(t);
    return img.isEmpty() ? null : img.toJPEG(70);
  }

  /** A tap from the phone at a point of the picture (0..1 across and down). */
  async tap(fx: number, fy: number): Promise<void> {
    const t = this.tabs.find((x) => x.id === this.active);
    if (!t) return;
    const [w, h] = (await t.view.webContents.executeJavaScript("[innerWidth, innerHeight]", true)) as [number, number];
    const x = Math.round(Math.min(1, Math.max(0, fx)) * w);
    const y = Math.round(Math.min(1, Math.max(0, fy)) * h);
    t.view.webContents.sendInputEvent({ type: "mouseDown", x, y, button: "left", clickCount: 1 });
    t.view.webContents.sendInputEvent({ type: "mouseUp", x, y, button: "left", clickCount: 1 });
  }

  /** Closes every tab (the app window is closing). */
  destroy(): void {
    for (const t of [...this.tabs]) this.close(t.id);
    if (this.helper && !this.helper.isDestroyed()) this.helper.destroy();
  }
}

/**
 * Electron main process.
 *
 * The desktop app is deliberately thin: it starts the same core server that
 * `kesher-core` runs from the command line, then shows the web UI in a
 * window. Everything the window can do, a phone or a script can do through
 * the same HTTP API — there is no desktop-only back channel.
 *
 * In development (`KESHER_DEV_URL` set) the window loads the Vite dev
 * server for hot reload; in a packaged build it loads the UI the core
 * server serves from `resources/web`.
 */
import { app, BrowserWindow, shell, dialog, ipcMain, powerSaveBlocker, globalShortcut, Tray, Menu, Notification, nativeImage, desktopCapturer, powerMonitor, screen as displays } from "electron";
import { join, resolve, sep } from "node:path";
import { chmod, copyFile, readFile, rename, stat, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import type { KesherServer } from "@kesher/core";
import { branding } from "@kesher/shared";
import { BrowserPane } from "./browser-pane.js";
import { connectComputer, forgetComputer, listComputers, openComputer } from "./computers.js";
import { WORKER_PORT, workerHost } from "./worker.js";

/**
 * The project's Google and GitHub sign-in clients. Release builds get it from the
 * repository's secrets (written next to main.js at build time, never in the
 * source); developers can set KESHER_GOOGLE_CLIENT_ID / _SECRET instead.
 */
async function googleClient(): Promise<{ googleClient?: { clientId: string; clientSecret: string }; githubClientId?: string }> {
  let j: { clientId?: string; clientSecret?: string; githubClientId?: string } = {};
  try {
    j = JSON.parse(await readFile(join(import.meta.dirname, "google-client.json"), "utf8")) as typeof j;
  } catch {
    // not a release build
  }
  const google = process.env.KESHER_GOOGLE_CLIENT_ID ? { clientId: process.env.KESHER_GOOGLE_CLIENT_ID, clientSecret: process.env.KESHER_GOOGLE_CLIENT_SECRET ?? "" } : j.clientId ? { clientId: j.clientId, clientSecret: j.clientSecret ?? "" } : undefined;
  // The project's id is built in (branding); a developer's env var still wins.
  const github = process.env.KESHER_GITHUB_CLIENT_ID || branding.github.clientId || j.githubClientId;
  return { ...(google ? { googleClient: google } : {}), ...(github ? { githubClientId: github } : {}) };
}

let server: KesherServer | undefined;

/** Folder of bundled resources: `resources/` when packaged, the repo when not. */
function resourcesDir(): string {
  return app.isPackaged ? process.resourcesPath : resolve(import.meta.dirname, "../../..");
}

async function runningCore(port: number): Promise<string | undefined> {
  const url = `http://127.0.0.1:${port}`;
  const health = (await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1500) }).then((r) => r.json()).catch(() => null)) as { productName?: string } | null;
  if (health?.productName !== branding.productName) return undefined;
  // A developer copy (`pnpm dev`) may run without the built interface.
  const page = await fetch(url, { signal: AbortSignal.timeout(1500) }).catch(() => undefined);
  if (!page?.ok || !page.headers.get("content-type")?.includes("text/html")) {
    throw new Error(`Another ${branding.productName} is already running on port ${port} without its interface (probably the developer version in a command window). Close that window, or restart the computer, and open ${branding.productName} again.`);
  }
  return url;
}

async function startCore(): Promise<string> {
  // KesherAI is already running (e.g. `pnpm dev` or the browser version): show that one.
  const existing = await runningCore(branding.defaultPort);
  if (existing) return existing;
  const root = resourcesDir();
  const host = app.isPackaged ? workerHost({ dataDir: process.env.KESHER_DATA_DIR ?? join(app.getPath("home"), `.${branding.appId}`), version: app.getVersion(), exe: process.execPath, mainUrl: () => `http://127.0.0.1:${server?.services.config.port ?? branding.defaultPort}` }) : undefined;
  // Loaded here, not at the top: if the core cannot load (a broken update), the rescue window still shows.
  const { createKesherServer } = await import("@kesher/core");
  const s = await createKesherServer({
    webDir: app.isPackaged ? join(root, "web") : join(root, "apps/web/dist"),
    pluginRoots: [join(root, "plugins")],
    ...(await googleClient()),
    // "My day" takes its pictures with Electron's own screen capture (antivirus programs block a script doing it).
    focusApp: () => showWindow(),
    // From the interface or the phone: restart, with a downloaded update installed first.
    restartApp: () => {
      if (server) server.services.restarting = true;
      if (readyInstaller) {
        const { file } = readyInstaller;
        readyInstaller = undefined;
        void runInstaller(file);
        return;
      }
      app.relaunch();
      quitting = true;
      app.quit();
    },
    screen: {
      idleSec: () => powerMonitor.getSystemIdleTime(),
      shot: async () => {
        const d = displays.getPrimaryDisplay();
        const size = { width: Math.round(d.size.width * d.scaleFactor), height: Math.round(d.size.height * d.scaleFactor) };
        const [src] = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: size });
        if (!src) throw new Error("The screen could not be captured.");
        const img = src.thumbnail;
        const small = img.resize({ width: Math.min(1280, size.width) });
        return { png: img.toPNG(), jpeg: small.toJPEG(55), tiny: img.resize({ width: 32, height: 18 }).toBitmap() };
      },
    },
    // Self-work runs in the worker (an installed copy only), so an update never stops it.
    ...(host ? { workerHost: host } : {}),
    // An installed copy updates from the project's GitHub releases: download the installer, run it, quit.
    ...(app.isPackaged
      ? {
          updates: {
            version: app.getVersion(),
            repo: "Deadchu-R/KesherAI",
            install: async (file: string) => {
              // Found by the automatic check: install when the user restarts or quits, not in the middle of their work.
              if (autoUpdating) return updateDownloaded(file);
              await runInstaller(file);
            },
          },
        }
      : {}),
  });
  try {
    const url = await s.listen();
    server = s;
    autoUpdate();
    // A self-work run that was working comes back (in a worker of this version), and an older worker moves on.
    host?.watch();
    return url;
  } catch (err) {
    await s.close().catch(() => undefined);
    const other = (err as NodeJS.ErrnoException).code === "EADDRINUSE" ? await runningCore(s.services.config.port) : undefined;
    if (other) return other;
    throw err;
  }
}

/**
 * After an update the new app can start while the old one is still closing: it then shows the old
 * copy's server, which goes away a moment later (the window shows "Failed to fetch" and nothing
 * works). When this app did not start its own server and the one it shows stops answering, it starts
 * its own and reloads the window.
 */
function watchCore(url: string): void {
  if (server || process.env.KESHER_DEV_URL) return;
  let misses = 0;
  const timer = setInterval(() => {
    void fetch(`${url}/api/health`, { signal: AbortSignal.timeout(3000) }).then(
      (r) => {
        misses = r.ok ? 0 : misses + 1;
      },
      () => {
        misses++;
      },
    ).then(async () => {
      if (misses < 2 || server) return;
      clearInterval(timer);
      try {
        const own = await startCore();
        for (const w of BrowserWindow.getAllWindows()) void w.loadURL(own);
        if (!server) watchCore(own);
      } catch (err) {
        await rescue(err);
      }
    });
  }, 4000);
}

// ---------- automatic updates for installed copies ----------
let autoUpdating = false;
let readyInstaller: { file: string; version?: string } | undefined;
let refreshTrayMenu: () => void = () => undefined;

/** Runs a downloaded installer: silently on Windows (then the app starts again), opened on a Mac. */
async function runInstaller(file: string): Promise<void> {
  if (process.platform === "darwin") {
    // A disk image: open it so the new app can be dragged to Applications.
    await shell.openPath(file);
    return;
  }
  if (process.platform === "linux") return linuxUpdate(file);
  // The new version starts by itself: keep the tunnel so the phone's link keeps working.
  if (server) server.services.restarting = true;
  // NSIS: /S installs without questions, --force-run opens the new version when done.
  spawn(file, process.platform === "win32" ? ["/S", "--force-run"] : [], { detached: true, stdio: "ignore" }).unref();
  setTimeout(() => {
    quitting = true;
    app.quit();
  }, 1500);
}

/**
 * Linux. Starting the downloaded copy beside the running one did not work: the new copy saw this one still open,
 * gave way and closed, and the next start opened the old copy again (found on a brother's PC). So:
 * - An AppImage (APPIMAGE is its path) is replaced by the new one in place, then this app restarts from it.
 * - A .deb install is updated by the system's package tool, which asks for the computer's password in its own
 *   window (pkexec); then this app restarts. Without pkexec, the .deb opens in the system's software installer.
 *
 * @param file - The downloaded AppImage or .deb.
 */
async function linuxUpdate(file: string): Promise<void> {
  const restart = (execPath?: string) => {
    if (server) server.services.restarting = true;
    app.relaunch(execPath ? { execPath, args: process.argv.slice(1).filter((a) => !a.startsWith("--updated")) } : undefined);
    quitting = true;
    app.quit();
  };
  const image = process.env.APPIMAGE;
  if (/\.AppImage$/i.test(file) && image) {
    const next = `${image}.new`;
    await copyFile(file, next);
    await chmod(next, 0o755);
    await rename(next, image);
    restart(image);
    return;
  }
  if (/\.deb$/i.test(file)) {
    await new Promise<void>((resolve) => {
      const p = spawn("pkexec", ["dpkg", "-i", file], { stdio: "ignore" });
      p.on("error", () => {
        void shell.openPath(file);
        resolve();
      });
      p.on("exit", (code) => {
        if (code === 0) restart();
        else if (code !== 126 && code !== 127) void shell.openPath(file); // 126: the user closed the password window
        resolve();
      });
    });
    return;
  }
  // An AppImage downloaded for a copy that is not one (it was started from a folder): run the new one alone.
  await chmod(file, 0o755);
  restart(file);
}

function updateDownloaded(file: string): void {
  readyInstaller = { file, ...(latestSeen ? { version: latestSeen } : {}) };
  refreshTrayMenu();
  if (Notification.isSupported()) {
    const whatsNew = latestNotes.slice(0, 3).map((l) => `• ${l}`).join("\n");
    const n = new Notification({ title: `${branding.productName} ${latestSeen ? `v${latestSeen} ` : ""}is ready`, body: `${whatsNew ? `${whatsNew}\n` : ""}Click to see what's new and update.` });
    // Show what changed first (Settings → Updates lists it, with an Update button).
    n.on("click", () => {
      showWindow();
      void BrowserWindow.getAllWindows()[0]?.loadURL(`http://127.0.0.1:${server?.services.config.port ?? branding.defaultPort}/#/settings`);
    });
    n.show();
  }
}

let latestSeen: string | undefined;
let latestNotes: string[] = [];

/** Checks GitHub for a new version now and then, and downloads it in the background. */
function autoUpdate(): void {
  if (!app.isPackaged || process.env.KESHER_NO_AUTO_UPDATE) return;
  const run = async () => {
    const updater = server?.services.updater;
    if (!updater || readyInstaller || updater.status().running) return;
    try {
      const c = await updater.check();
      if (!c.newCommits.length) return;
      latestSeen = c.latestVersion;
      latestNotes = c.newCommits.map((x) => x.subject);
      autoUpdating = true;
      await updater.apply();
      // The download runs in the background; wait for it, then the install hook keeps it for later.
      while (updater.status().running) await new Promise((r) => setTimeout(r, 2000));
    } catch {
      // offline or GitHub busy: try again later
    } finally {
      autoUpdating = false;
    }
  };
  setTimeout(() => void run(), 60_000);
  setInterval(() => void run(), 4 * 60 * 60_000);
}

/** `--worker`: the window-less self-work KesherAI (see worker.ts); it has its own profile, so it is not "another window". */
const workerMode = process.argv.includes("--worker");
if (workerMode) app.setPath("userData", join(app.getPath("userData"), "worker"));

// One window: opening KesherAI again focuses the existing window.
if (!app.requestSingleInstanceLock()) app.quit();
/** `--headless` (or `--server`): run KesherAI without a window, as a server for the phone and other computers (the tray icon opens the window). */
const headless = process.argv.includes("--headless") || process.argv.includes("--server");

app.on("second-instance", () => showWindow());

/** Where the window was last time (it opens there again, maximized if it was). */
const windowFile = () => join(app.getPath("userData"), "window.json");
interface WindowState { x?: number; y?: number; width: number; height: number; maximized?: boolean; /** The middle of the window as shown (a maximized window can sit on another monitor than its normal place). */ cx?: number; cy?: number }

/**
 * The last window place, only when it is still on a connected monitor (a
 * monitor that was unplugged must not hide the window off-screen).
 */
function lastWindow(): WindowState | undefined {
  try {
    const w = JSON.parse(readFileSync(windowFile(), "utf8")) as WindowState;
    if (!(w.width >= 600 && w.height >= 400)) return undefined;
    // Maximized: open on the monitor it was maximized on, whatever its normal place was.
    if (w.maximized && w.cx !== undefined && w.cy !== undefined) {
      const d = displays.getAllDisplays().find((x) => w.cx! >= x.bounds.x && w.cx! < x.bounds.x + x.bounds.width && w.cy! >= x.bounds.y && w.cy! < x.bounds.y + x.bounds.height);
      if (d) {
        const width = Math.min(w.width, d.workArea.width);
        const height = Math.min(w.height, d.workArea.height);
        return { width, height, maximized: true, x: d.workArea.x + Math.round((d.workArea.width - width) / 2), y: d.workArea.y + Math.round((d.workArea.height - height) / 2) };
      }
    }
    if (w.x === undefined || w.y === undefined) return { width: w.width, height: w.height, ...(w.maximized ? { maximized: true } : {}) };
    const on = displays.getAllDisplays().some((d) => {
      const a = d.workArea;
      return w.x! + 100 > a.x && w.x! + 100 < a.x + a.width && w.y! + 40 > a.y && w.y! + 40 < a.y + a.height;
    });
    return on ? w : { width: w.width, height: w.height };
  } catch {
    return undefined;
  }
}

/** Keeps the window's place up to date (a moment after it moves or resizes). */
function rememberWindow(win: BrowserWindow): void {
  let timer: NodeJS.Timeout | undefined;
  // Kept from the events: a hidden window (in the tray, or closing for an update) says it is not maximized on Windows,
  // which made KesherAI reopen small on another monitor after an update.
  let maximized = win.isMaximized();
  const save = () => {
    if (win.isDestroyed() || win.isMinimized() || !win.isVisible()) return;
    const b = win.getNormalBounds();
    const now = win.getBounds();
    void writeFile(windowFile(), JSON.stringify({ x: b.x, y: b.y, width: b.width, height: b.height, maximized, cx: now.x + Math.round(now.width / 2), cy: now.y + Math.round(now.height / 2) })).catch(() => undefined);
  };
  const later = () => {
    clearTimeout(timer);
    timer = setTimeout(save, 800);
  };
  win.on("move", later);
  win.on("resize", later);
  win.on("maximize", () => ((maximized = true), later()));
  win.on("unmaximize", () => ((maximized = false), later()));
  win.on("close", save);
}

async function createWindow(url: string): Promise<void> {
  const last = lastWindow();
  const win = new BrowserWindow({
    width: last?.width ?? 1440,
    height: last?.height ?? 900,
    ...(last?.x !== undefined && last.y !== undefined ? { x: last.x, y: last.y } : {}),
    minWidth: 900,
    minHeight: 600,
    title: branding.productName,
    backgroundColor: "#121213",
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      preload: join(import.meta.dirname, "preload.cjs"),
    },
  });

  // Recording a meeting: KesherAI's own page asks for the screen's sound ("loopback": what the call
  // plays) without a picker; the page keeps only the audio. Only for KesherAI's own address.
  win.webContents.session.setDisplayMediaRequestHandler((request, callback) => {
    if (!request.securityOrigin || !url.startsWith(new URL(request.securityOrigin).origin)) return callback({});
    void desktopCapturer.getSources({ types: ["screen"] }).then((sources) => {
      const screen = sources[0];
      callback(screen ? { video: screen, audio: "loopback" } : {});
    }, () => callback({}));
  });

  // Links to other sites open in the user's browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:\/\//.test(target)) void shell.openExternal(target);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, target) => {
    if (!target.startsWith(`${url}/`) && target !== url) {
      event.preventDefault();
      void shell.openExternal(target);
    }
  });

  if (last?.maximized) win.maximize();
  rememberWindow(win);
  // The browser pane is new: if it cannot start, the app still opens (the model uses the extension, if any).
  try {
    setupBrowserPane(win);
  } catch (err) {
    console.warn(`[browser pane] ${(err as Error).message}`);
  }

  // Closing the window keeps KesherAI working in the background (chats, downloads, tasks), in the tray.
  win.on("close", (event) => {
    if (quitting) return;
    event.preventDefault();
    win.hide();
    if (!toldAboutTray && Notification.isSupported()) {
      toldAboutTray = true;
      new Notification({ title: branding.productName, body: "Still running in the background: chats and downloads keep going. Quit from the tray icon." }).show();
    }
  });

  await win.loadURL(url);
}

/** KesherAI's own browser pane in the app window (see browser-pane.ts). */
let pane: BrowserPane | undefined;

function setupBrowserPane(win: BrowserWindow): void {
  const port = server?.services.config.port;
  if (!server || !port) return;
  const send = () => {
    if (!win.isDestroyed() && pane) win.webContents.send("kesher:browser-state", { tabs: pane.list(), notice: pane.notice });
  };
  pane = new BrowserPane(win, port, send);
  const p = pane;
  // The model's browser tools and the phone's view of the pane go through the core's browser bridge.
  server.services.browser.attachPane(async (action, a) => {
    if (action === "pane-state") return { tabs: p.list(), notice: p.notice };
    if (action === "pane-shot") return p.shot();
    if (action === "pane-tap") return p.tap(Number(a.x), Number(a.y));
    if (action === "pane-go") return (await p.open(String(a.url ?? ""), undefined, !p.list().length), true);
    if (action === "pane-nav") return p.nav(a.what === "forward" ? "forward" : a.what === "reload" ? "reload" : a.what === "stop" ? "stop" : "back");
    if (action === "pane-select") return p.select(Number(a.id));
    if (action === "pane-close") return p.close(Number(a.id));
    if (action === "pane-new") return (p.newTab(), true);
    return p.run(action, a);
  });
  win.on("closed", () => {
    server?.services.browser.attachPane(undefined);
    p.destroy();
    pane = undefined;
  });
}

ipcMain.handle("kesher:browser", async (event, cmd: unknown, arg: unknown) => {
  if (!fromApp(event) || !pane) return { error: "Not allowed." };
  try {
    if (cmd === "state") return { tabs: pane.list(), notice: pane.notice };
    if (cmd === "bounds") {
      const b = arg as { x?: unknown; y?: unknown; width?: unknown; height?: unknown } | null;
      pane.setBounds(b && [b.x, b.y, b.width, b.height].every((v) => typeof v === "number" && Number.isFinite(v)) ? { x: b.x as number, y: b.y as number, width: b.width as number, height: b.height as number } : null);
      return true;
    }
    if (cmd === "go" && typeof arg === "string" && arg.length < 4000) return (await pane.open(arg, undefined, !pane.list().length), true);
    if (cmd === "nav" && (arg === "back" || arg === "forward" || arg === "reload" || arg === "stop")) return pane.nav(arg);
    if (cmd === "select" && typeof arg === "number") return pane.select(arg);
    if (cmd === "close" && typeof arg === "number") return pane.close(arg);
    if (cmd === "new") return (pane.newTab(), true);
    if (cmd === "dismiss") return ((pane.notice = ""), true);
    return { error: "Unknown command." };
  } catch (err) {
    return { error: (err as Error).message };
  }
});

let quitting = false;
let toldAboutTray = false;
let tray: Tray | undefined;

/** Shows the window again (from the tray, a notification, or a second launch). */
function showWindow(): void {
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) {
    // Started without a window (--headless): make it now.
    void createWindow(process.env.KESHER_DEV_URL ?? `http://127.0.0.1:${server?.services.config.port ?? branding.defaultPort}`);
    return;
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

/**
 * The tray icon: open, what is running, quit. While the window is closed
 * it polls the core and shows a notification when a chat finishes or a
 * download completes, so the user can leave KesherAI working.
 */
function setupTray(coreUrl: string): void {
  const dist = app.isPackaged ? join(resourcesDir(), "web") : join(resourcesDir(), "apps/web/dist");
  const icon = nativeImage.createFromPath(join(dist, "icon-192.png")).resize({ width: 18, height: 18 });
  tray = new Tray(icon);
  tray.setToolTip(branding.productName);
  const base = coreUrl.replace(/\/$/, "");
  let status = "";
  const menu = () =>
    Menu.buildFromTemplate([
      { label: `Open ${branding.productName}`, click: showWindow },
      ...(status ? [{ label: status, enabled: false }] : []),
      ...(readyInstaller ? [{ label: `Restart and update${readyInstaller.version ? ` to v${readyInstaller.version}` : ""}`, click: () => void runInstaller(readyInstaller!.file) }] : []),
      { type: "separator" },
      { label: "Quit (stops chats and downloads)", click: () => { quitting = true; app.quit(); } },
    ]);
  tray.setContextMenu(menu());
  tray.on("click", showWindow);
  refreshTrayMenu = () => tray?.setContextMenu(menu());

  let running: Record<string, string> = {};
  let downloading = new Set<string>();
  const poll = async () => {
    try {
      const [activity, jobs, convs] = await Promise.all([
        fetch(`${base}/api/conversations/activity`).then((r) => r.json() as Promise<Record<string, string>>),
        fetch(`${base}/api/downloads`).then((r) => (r.ok ? (r.json() as Promise<Array<{ id: string; status: string; label?: string }>>) : [])),
        fetch(`${base}/api/conversations`).then((r) => r.json() as Promise<Array<{ id: string; title: string }>>),
      ]);
      // Off in Settings → Notifications: no notifications on this computer.
      const hidden = server?.services.config.notifications.desktop !== false && !BrowserWindow.getAllWindows().some((w) => w.isVisible() && w.isFocused());
      for (const id of Object.keys(running)) {
        if (!activity[id] && hidden && Notification.isSupported()) {
          const title = convs.find((c) => c.id === id)?.title ?? "A chat";
          const n = new Notification({ title: `${title}: done`, body: "The answer is ready." });
          n.on("click", () => { showWindow(); void BrowserWindow.getAllWindows()[0]?.loadURL(`${base}/#/c/${id}`); });
          n.show();
        }
        if (activity[id] === "waiting" && running[id] !== "waiting" && hidden && Notification.isSupported()) {
          new Notification({ title: convs.find((c) => c.id === id)?.title ?? "A chat", body: "Waiting for your approval or answer." }).show();
        }
      }
      const active = new Set(jobs.filter((j) => /^(queued|downloading|verifying)$/.test(j.status)).map((j) => j.id));
      for (const id of downloading) {
        const job = jobs.find((j) => j.id === id);
        if (!active.has(id) && job && job.status === "done" && hidden && Notification.isSupported()) {
          new Notification({ title: "Download finished", body: job.label ?? "" }).show();
        }
      }
      running = activity;
      downloading = active;
      const n = Object.keys(activity).length;
      status = [n ? `${n} chat${n > 1 ? "s" : ""} working` : "", active.size ? `${active.size} download${active.size > 1 ? "s" : ""}` : ""].filter(Boolean).join(" · ");
      tray?.setToolTip(status ? `${branding.productName}: ${status}` : branding.productName);
      tray?.setContextMenu(menu());
    } catch {
      // the core is restarting; try again next time
    }
  };
  setInterval(() => void poll(), 4000);
}

/**
 * Whether a request to the desktop bridge comes from KesherAI's own window:
 * its main frame, on KesherAI's own address — never a frame inside it
 * (ComfyUI, a plugin page) or a page it was tricked into opening.
 */
function fromApp(event: Electron.IpcMainInvokeEvent): boolean {
  const frame = event.senderFrame;
  const port = server?.services.config.port;
  return !!frame && !!port && frame === event.sender.mainFrame && frame.url.startsWith(`http://127.0.0.1:${port}/`);
}

/** Whether a file is somewhere KesherAI's chats write programs: the outputs folder or a code session's folder. */
function madeByKesher(path: string): boolean {
  if (!server) return false;
  const full = resolve(path);
  const roots = [join(server.services.paths.root, "outputs"), ...server.services.library.listConversations().flatMap((c) => (c.workspace ? [c.workspace] : []))].map((r) => resolve(r));
  return roots.some((r) => full === r || full.startsWith(r + sep));
}

// The folder picker for "New code session" and the sync folder setting.
ipcMain.handle("kesher:pick-folder", async (event) => {
  if (!fromApp(event)) return null;
  const win = BrowserWindow.fromWebContents(event.sender);
  const result = win ? await dialog.showOpenDialog(win, { properties: ["openDirectory", "createDirectory"] }) : await dialog.showOpenDialog({ properties: ["openDirectory"] });
  return result.canceled ? null : (result.filePaths[0] ?? null);
});

// The paper-clip button in a conversation: attach files for the agent to use.
ipcMain.handle("kesher:pick-files", async (event) => {
  if (!fromApp(event)) return [];
  const win = BrowserWindow.fromWebContents(event.sender);
  const opts = { properties: ["openFile", "multiSelections"] as Array<"openFile" | "multiSelections"> };
  const result = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
  return result.canceled ? [] : result.filePaths;
});

// "Open folder" in a conversation's Files panel. Only folders, never files, so nothing is run.
ipcMain.handle("kesher:open-path", async (event, path: unknown) => {
  if (!fromApp(event) || typeof path !== "string") return;
  const st = await stat(path).catch(() => undefined);
  if (st?.isDirectory()) await shell.openPath(path);
});

// "Run" on a program the agent built. Only files inside KesherAI's outputs folder or a
// conversation's folder reach here, and only when the user clicks.
ipcMain.handle("kesher:run-file", async (event, path: unknown) => {
  if (!fromApp(event) || typeof path !== "string" || !madeByKesher(path)) return;
  const st = await stat(path).catch(() => undefined);
  if (st?.isFile()) await shell.openPath(path);
});

// After an update: start the app again with the new code.
/** Start with the computer, in the background (no window): `{ on }`, or read it. */
ipcMain.handle("kesher:startup", (event, on: unknown) => {
  if (typeof on === "boolean" && fromApp(event)) app.setLoginItemSettings({ openAtLogin: on, args: ["--headless"] });
  return app.getLoginItemSettings({ args: ["--headless"] }).openAtLogin;
});

/** Saves a chat as a PDF: its print-ready page, printed in a hidden window. */
ipcMain.handle("kesher:chat-pdf", async (event, id: unknown) => {
  if (!fromApp(event) || typeof id !== "string" || !/^[\w-]{1,80}$/.test(id) || !server) return null;
  const page = new BrowserWindow({ show: false, webPreferences: { javascript: false, sandbox: true } });
  try {
    const url = `http://127.0.0.1:${server.services.config.port}/api/conversations/${id}/export?format=html`;
    await page.loadURL(url);
    const pdf = await page.webContents.printToPDF({ printBackground: true, pageSize: "A4", margins: { marginType: "default" } });
    const title = page.getTitle().replace(/[\\/:*?"<>|]/g, " ").trim().slice(0, 80) || "chat";
    const parent = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const opts = { defaultPath: join(app.getPath("documents"), `${title}.pdf`), filters: [{ name: "PDF", extensions: ["pdf"] }] };
    const { canceled, filePath } = parent ? await dialog.showSaveDialog(parent, opts) : await dialog.showSaveDialog(opts);
    if (canceled || !filePath) return null;
    await writeFile(filePath, pdf);
    return filePath;
  } finally {
    page.destroy();
  }
});

// Another computer with KesherAI (Settings → Phone → "Connect this app to another computer").
const appIcon = () => join(app.isPackaged ? join(resourcesDir(), "web") : join(resourcesDir(), "apps/web/dist"), "icon-192.png");
ipcMain.handle("kesher:computers", async (event) => (fromApp(event) ? listComputers() : []));
ipcMain.handle("kesher:computer-connect", async (event, link: unknown) => (fromApp(event) && typeof link === "string" && link.length < 2000 ? connectComputer(link, appIcon()) : { error: "Not allowed." }));
ipcMain.handle("kesher:computer-open", async (event, origin: unknown) => (fromApp(event) && typeof origin === "string" ? openComputer(origin, appIcon()) : { error: "Not allowed." }));
// "My devices" (same Google account): open one of them; the address and token stay in this process.
ipcMain.handle("kesher:open-device", async (event, id: unknown) => {
  if (!fromApp(event) || typeof id !== "string" || !server) return { error: "Not allowed." };
  const p = server.services.devices.peer(id);
  if (!p) return { error: "That computer is not in My devices any more. Press Check now." };
  return connectComputer(`${p.url.replace(/\/$/, "")}/?token=${encodeURIComponent(p.token)}`, appIcon());
});
ipcMain.handle("kesher:computer-forget", async (event, origin: unknown) => {
  if (fromApp(event) && typeof origin === "string") await forgetComputer(origin);
});

ipcMain.handle("kesher:restart", (event) => {
  if (!fromApp(event)) return;
  app.relaunch();
  app.quit();
});

// "Keep this computer awake while remote access is on" (Settings → Phone).
// Checked every few seconds so the setting applies without a restart.
let awakeBlocker: number | undefined;
setInterval(() => {
  const remote = server?.services.config.remote;
  // Also while serving other apps and devices through the API, until a minute after the last request.
  const serving = Date.now() - (server?.services.lastServed?.() ?? 0) < 60_000;
  // And while self-work runs (in the worker, which has its own copy of this loop): an overnight run must not stop
  // because Windows went to sleep.
  const working = server?.services.selfWork?.current?.status === "running";
  const want = (!!remote?.enabled && !!remote.keepAwake) || serving || working;
  if (want && awakeBlocker === undefined) awakeBlocker = powerSaveBlocker.start("prevent-app-suspension");
  if (!want && awakeBlocker !== undefined) {
    powerSaveBlocker.stop(awakeBlocker);
    awakeBlocker = undefined;
  }
}, 5000);

app.whenReady().then(async () => {
  if (workerMode) {
    // The worker: only the server, for self-work; its models are the main app's.
    try {
      const mainUrl = process.argv.find((a) => a.startsWith("--main-url="))?.slice(11) ?? `http://127.0.0.1:${branding.defaultPort}`;
      if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(mainUrl)) throw new Error("The worker only works with the KesherAI on this computer.");
      const { createKesherServer } = await import("@kesher/core");
      const mainRoot = process.env.KESHER_MAIN_ROOT ?? join(app.getPath("home"), `.${branding.appId}`);
      server = await createKesherServer({ port: WORKER_PORT, autodetect: false, worker: { mainUrl, mainRoot, version: app.getVersion() } });
      await server.listen();
    } catch {
      app.exit(1);
    }
    return;
  }
  try {
    const coreUrl = await startCore();
    if (!headless) await createWindow(process.env.KESHER_DEV_URL ?? coreUrl);
    watchCore(coreUrl);
    setupTray(coreUrl);
    // Going to sleep or shutting down: tell my other computers at once, so they stop waiting on this one; and when back.
    const announce = (state: "asleep" | "awake") => fetch(`${coreUrl.replace(/\/$/, "")}/api/devices/announce`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ state }), signal: AbortSignal.timeout(3000) }).catch(() => undefined);
    announceAway = () => announce("asleep");
    powerMonitor.on("suspend", () => void announce("asleep"));
    powerMonitor.on("shutdown", () => void announce("asleep"));
    powerMonitor.on("resume", () => setTimeout(() => void announce("awake"), 5000));
    // Stops computer control from anywhere, even when another app is in front.
    const stopKey = process.platform === "darwin" ? "Command+Shift+Escape" : "Control+Alt+Escape";
    globalShortcut.register(stopKey, () => {
      void fetch(`${coreUrl.replace(/\/$/, "")}/api/computer/stop`, { method: "POST" }).catch(() => undefined);
      BrowserWindow.getAllWindows()[0]?.show();
    });
  } catch (err) {
    await rescue(err);
  }
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length > 0) showWindow();
    else {
      void createWindow(process.env.KESHER_DEV_URL ?? `http://127.0.0.1:${server?.services.config.port ?? branding.defaultPort}`);
    }
  });
});

/**
 * When KesherAI cannot start: instead of only an error, ways out — get the
 * latest version (a fixed update), reset the settings (kept in a backup) and
 * try again, or open the data folder.
 */
async function rescue(err: unknown): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  const dataDir = process.env.KESHER_DATA_DIR ?? join(app.getPath("home"), `.${branding.appId}`);
  const { response } = await dialog.showMessageBox({
    type: "error",
    title: `${branding.productName} could not start`,
    message: `${branding.productName} could not start.`,
    detail: `${message.slice(0, 900)}\n\nYour chats and files are safe. What would you like to do?`,
    buttons: ["Download the latest version", "Reset the settings and try again", "Open the data folder", "Quit"],
    defaultId: 0,
    cancelId: 3,
    noLink: true,
  });
  if (response === 0) await shell.openExternal("https://github.com/Deadchu-R/KesherAI/releases/latest");
  if (response === 1) {
    // The settings move to backups/ (nothing is deleted), and KesherAI starts with fresh ones.
    const { mkdir, rename } = await import("node:fs/promises");
    const backups = join(dataDir, "backups");
    await mkdir(backups, { recursive: true }).catch(() => undefined);
    await rename(join(dataDir, "config.json"), join(backups, `config-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.json`)).catch(() => undefined);
    app.relaunch();
  }
  if (response === 2) await shell.openPath(dataDir);
  quitting = true;
  app.quit();
}

app.on("will-quit", () => globalShortcut.unregisterAll());

// The window hides instead of closing (see createWindow), so the app keeps working until Quit.
app.on("window-all-closed", () => {
  if (quitting) app.quit();
});

/** Tells my other computers this one is going away (set once the server runs). */
let announceAway: (() => Promise<unknown>) | undefined;

app.on("before-quit", (event) => {
  quitting = true;
  // A downloaded update installs as the app closes (silently on Windows).
  if (readyInstaller && process.platform === "win32") {
    const { file } = readyInstaller;
    readyInstaller = undefined;
    spawn(file, process.platform === "win32" ? ["/S"] : [], { detached: true, stdio: "ignore" }).unref();
  }
  if (!server) return;
  event.preventDefault();
  const s = server;
  server = undefined;
  // Never hang on the way out (a restart that never came back was seen on the PC): after 10 s, exit anyway, so a
  // relaunch can start the new copy.
  const force = setTimeout(() => app.exit(0), 10_000);
  void Promise.resolve(announceAway?.())
    .finally(() => s.close())
    .finally(() => {
      clearTimeout(force);
      // exit, not quit: seen on the PC, the window stayed open with its server already closed ("The core server is
      // not answering") and the relaunched copy gave way to it. A relaunch asked for earlier still happens.
      app.exit(0);
    });
});

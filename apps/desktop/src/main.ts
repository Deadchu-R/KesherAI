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
import { join, resolve } from "node:path";
import { chmod, readFile, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createKesherServer, type KesherServer } from "@kesher/core";
import { branding } from "@kesher/shared";

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
  const s = await createKesherServer({
    webDir: app.isPackaged ? join(root, "web") : join(root, "apps/web/dist"),
    pluginRoots: [join(root, "plugins")],
    ...(await googleClient()),
    // "My day" takes its pictures with Electron's own screen capture (antivirus programs block a script doing it).
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
    return url;
  } catch (err) {
    await s.close().catch(() => undefined);
    const other = (err as NodeJS.ErrnoException).code === "EADDRINUSE" ? await runningCore(s.services.config.port) : undefined;
    if (other) return other;
    throw err;
  }
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
  if (process.platform === "linux") await chmod(file, 0o755);
  // NSIS: /S installs without questions, --force-run opens the new version when done.
  spawn(file, process.platform === "win32" ? ["/S", "--force-run"] : [], { detached: true, stdio: "ignore" }).unref();
  setTimeout(() => {
    quitting = true;
    app.quit();
  }, 1500);
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

// One window: opening KesherAI again focuses the existing window.
if (!app.requestSingleInstanceLock()) app.quit();
app.on("second-instance", () => showWindow());

async function createWindow(url: string): Promise<void> {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
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
    if (!target.startsWith(url)) {
      event.preventDefault();
      void shell.openExternal(target);
    }
  });

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

let quitting = false;
let toldAboutTray = false;
let tray: Tray | undefined;

/** Shows the window again (from the tray, a notification, or a second launch). */
function showWindow(): void {
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) return;
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
      const hidden = !BrowserWindow.getAllWindows().some((w) => w.isVisible() && w.isFocused());
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

// The folder picker for "New code session" and the sync folder setting.
ipcMain.handle("kesher:pick-folder", async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const result = win ? await dialog.showOpenDialog(win, { properties: ["openDirectory", "createDirectory"] }) : await dialog.showOpenDialog({ properties: ["openDirectory"] });
  return result.canceled ? null : (result.filePaths[0] ?? null);
});

// The paper-clip button in a conversation: attach files for the agent to use.
ipcMain.handle("kesher:pick-files", async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const opts = { properties: ["openFile", "multiSelections"] as Array<"openFile" | "multiSelections"> };
  const result = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
  return result.canceled ? [] : result.filePaths;
});

// "Open folder" in a conversation's Files panel. Only folders, never files, so nothing is run.
ipcMain.handle("kesher:open-path", async (_event, path: unknown) => {
  if (typeof path !== "string") return;
  const st = await stat(path).catch(() => undefined);
  if (st?.isDirectory()) await shell.openPath(path);
});

// "Run" on a program the agent built. Only files inside KesherAI's outputs folder or a
// conversation's folder reach here, and only when the user clicks.
ipcMain.handle("kesher:run-file", async (_event, path: unknown) => {
  if (typeof path !== "string") return;
  const st = await stat(path).catch(() => undefined);
  if (st?.isFile()) await shell.openPath(path);
});

// After an update: start the app again with the new code.
ipcMain.handle("kesher:restart", () => {
  app.relaunch();
  app.quit();
});

// "Keep this computer awake while remote access is on" (Settings → Phone).
// Checked every few seconds so the setting applies without a restart.
let awakeBlocker: number | undefined;
setInterval(() => {
  const remote = server?.services.config.remote;
  const want = !!remote?.enabled && !!remote.keepAwake;
  if (want && awakeBlocker === undefined) awakeBlocker = powerSaveBlocker.start("prevent-app-suspension");
  if (!want && awakeBlocker !== undefined) {
    powerSaveBlocker.stop(awakeBlocker);
    awakeBlocker = undefined;
  }
}, 5000);

app.whenReady().then(async () => {
  try {
    const coreUrl = await startCore();
    await createWindow(process.env.KESHER_DEV_URL ?? coreUrl);
    setupTray(coreUrl);
    // Stops computer control from anywhere, even when another app is in front.
    const stopKey = process.platform === "darwin" ? "Command+Shift+Escape" : "Control+Alt+Escape";
    globalShortcut.register(stopKey, () => {
      void fetch(`${coreUrl.replace(/\/$/, "")}/api/computer/stop`, { method: "POST" }).catch(() => undefined);
      BrowserWindow.getAllWindows()[0]?.show();
    });
  } catch (err) {
    dialog.showErrorBox(`${branding.productName} could not start`, err instanceof Error ? err.message : String(err));
    app.quit();
  }
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length > 0) showWindow();
    else {
      void createWindow(process.env.KESHER_DEV_URL ?? `http://127.0.0.1:${server?.services.config.port ?? branding.defaultPort}`);
    }
  });
});

app.on("will-quit", () => globalShortcut.unregisterAll());

// The window hides instead of closing (see createWindow), so the app keeps working until Quit.
app.on("window-all-closed", () => {
  if (quitting) app.quit();
});

app.on("before-quit", (event) => {
  quitting = true;
  // A downloaded update installs as the app closes (silently on Windows).
  if (readyInstaller && process.platform !== "darwin") {
    const { file } = readyInstaller;
    readyInstaller = undefined;
    spawn(file, process.platform === "win32" ? ["/S"] : [], { detached: true, stdio: "ignore" }).unref();
  }
  if (!server) return;
  event.preventDefault();
  const s = server;
  server = undefined;
  void s.close().finally(() => app.quit());
});

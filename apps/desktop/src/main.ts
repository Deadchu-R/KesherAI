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
import { app, BrowserWindow, shell, dialog, ipcMain, powerSaveBlocker } from "electron";
import { join, resolve } from "node:path";
import { createKesherServer, type KesherServer } from "@kesher/core";
import { branding } from "@kesher/shared";

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
  });
  try {
    const url = await s.listen();
    server = s;
    return url;
  } catch (err) {
    await s.close().catch(() => undefined);
    const other = (err as NodeJS.ErrnoException).code === "EADDRINUSE" ? await runningCore(s.services.config.port) : undefined;
    if (other) return other;
    throw err;
  }
}

// One window: opening KesherAI again focuses the existing window.
if (!app.requestSingleInstanceLock()) app.quit();
app.on("second-instance", () => {
  const win = BrowserWindow.getAllWindows()[0];
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

async function createWindow(url: string): Promise<void> {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: branding.productName,
    backgroundColor: "#0E1014",
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      preload: join(import.meta.dirname, "preload.cjs"),
    },
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

  await win.loadURL(url);
}

// The folder picker for "New code session" and the sync folder setting.
ipcMain.handle("kesher:pick-folder", async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const result = win ? await dialog.showOpenDialog(win, { properties: ["openDirectory", "createDirectory"] }) : await dialog.showOpenDialog({ properties: ["openDirectory"] });
  return result.canceled ? null : (result.filePaths[0] ?? null);
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
  } catch (err) {
    dialog.showErrorBox(`${branding.productName} could not start`, err instanceof Error ? err.message : String(err));
    app.quit();
  }
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void createWindow(process.env.KESHER_DEV_URL ?? `http://127.0.0.1:${server?.services.config.port ?? branding.defaultPort}`);
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", (event) => {
  if (!server) return;
  event.preventDefault();
  const s = server;
  server = undefined;
  void s.close().finally(() => app.quit());
});

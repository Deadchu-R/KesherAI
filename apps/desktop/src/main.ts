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
import { app, BrowserWindow, shell, dialog } from "electron";
import { join, resolve } from "node:path";
import { createKesherServer, type KesherServer } from "@kesher/core";
import { branding } from "@kesher/shared";

let server: KesherServer | undefined;

/** Folder of bundled resources: `resources/` when packaged, the repo when not. */
function resourcesDir(): string {
  return app.isPackaged ? process.resourcesPath : resolve(import.meta.dirname, "../../..");
}

async function startCore(): Promise<string> {
  const root = resourcesDir();
  server = await createKesherServer({
    webDir: app.isPackaged ? join(root, "web") : join(root, "apps/web/dist"),
    pluginRoots: [join(root, "plugins")],
  });
  return server.listen();
}

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

app.whenReady().then(async () => {
  try {
    const coreUrl = await startCore();
    await createWindow(process.env.KESHER_DEV_URL ?? coreUrl);
  } catch (err) {
    dialog.showErrorBox(`${branding.productName} could not start`, err instanceof Error ? err.message : String(err));
    app.quit();
  }
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0 && server) {
      void createWindow(process.env.KESHER_DEV_URL ?? `http://127.0.0.1:${server.services.config.port}`);
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

/**
 * Preload script: the only bridge between the web UI and Electron.
 * It exposes a tiny, explicit API on `window.kesherDesktop`; the page gets
 * no other access to Node or Electron (contextIsolation + sandbox).
 *
 * Written as CommonJS (.cts) because sandboxed preload scripts cannot be
 * ES modules.
 */
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("kesherDesktop", {
  /** Opens the system folder picker. Resolves with the path, or null if cancelled. */
  pickFolder: (): Promise<string | null> => ipcRenderer.invoke("kesher:pick-folder"),
  /** Closes and reopens the app, e.g. after an update. */
  restart: (): Promise<void> => ipcRenderer.invoke("kesher:restart"),
});

/**
 * Preload script: the only bridge between the web UI and Electron.
 * It exposes a tiny, explicit API on `window.kesherDesktop`; the page gets
 * no other access to Node or Electron (contextIsolation + sandbox).
 *
 * Written as CommonJS (.cts) because sandboxed preload scripts cannot be
 * ES modules.
 */
import { contextBridge, ipcRenderer, webUtils } from "electron";

contextBridge.exposeInMainWorld("kesherDesktop", {
  /** Opens the system folder picker. Resolves with the path, or null if cancelled. */
  pickFolder: (): Promise<string | null> => ipcRenderer.invoke("kesher:pick-folder"),
  /** Start with the computer in the background; pass nothing to read it. */
  startup: (on?: boolean): Promise<boolean> => ipcRenderer.invoke("kesher:startup", on),
  /** Closes and reopens the app, e.g. after an update. */
  restart: (): Promise<void> => ipcRenderer.invoke("kesher:restart"),
  /** Opens a folder in Explorer / Finder. */
  openPath: (path: string): Promise<void> => ipcRenderer.invoke("kesher:open-path", path),
  /** Runs a program the agent built, when the user clicks Run on its card. */
  runFile: (path: string): Promise<void> => ipcRenderer.invoke("kesher:run-file", path),
  /** Opens the system file picker (several files allowed). */
  pickFiles: (): Promise<string[]> => ipcRenderer.invoke("kesher:pick-files"),
  /** The full path of a file dropped on the window. */
  pathOf: (file: File): string => webUtils.getPathForFile(file),
});

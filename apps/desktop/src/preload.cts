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
  /** Saves a chat as a PDF (asks where). Resolves with the file, or null if cancelled. */
  saveChatPdf: (id: string): Promise<string | null> => ipcRenderer.invoke("kesher:chat-pdf", id),
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
  /** Other computers this app connects to (names and addresses; keys never leave the main process). */
  computers: (): Promise<Array<{ name: string; origin: string }>> => ipcRenderer.invoke("kesher:computers"),
  /** Connects to another computer from its link and opens it in its own window. */
  connectComputer: (link: string): Promise<{ name?: string; error?: string }> => ipcRenderer.invoke("kesher:computer-connect", link),
  /** Opens a saved computer in its own window. */
  openComputer: (origin: string): Promise<{ error?: string }> => ipcRenderer.invoke("kesher:computer-open", origin),
  /** Opens one of "My devices" (same Google account) in its own window. */
  openDevice: (id: string): Promise<{ name?: string; error?: string }> => ipcRenderer.invoke("kesher:open-device", id),
  /** Forgets a saved computer (its key and its window's storage). */
  forgetComputer: (origin: string): Promise<void> => ipcRenderer.invoke("kesher:computer-forget", origin),
});

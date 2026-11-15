/**
 * The app's own short log (`logs/main.log` in the data folder): when it started, every way it ended (a quit and who
 * asked for it, an error nobody caught, a helper process or the page that crashed, the exit code). Kept on this
 * computer only, cut back when it passes 1 MB. Written synchronously so the last lines survive the process ending.
 */
import { appendFileSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { App } from "electron";

/**
 * Starts the log and watches for the ways the app can end.
 *
 * @param app - Electron's app.
 * @param file - The log file.
 * @returns A function that writes one line.
 */
export function startMainLog(app: App, file: string): (line: string) => void {
  const write = (line: string) => {
    try {
      appendFileSync(file, `${new Date().toISOString()} ${line.replace(/\s+$/, "")}\n`);
    } catch {
      // A log that cannot be written never stops the app.
    }
  };
  try {
    mkdirSync(dirname(file), { recursive: true });
    if ((statSync(file, { throwIfNoEntry: false })?.size ?? 0) > 1024 * 1024) writeFileSync(file, "");
  } catch {
    // As above.
  }
  write(`start ${app.getVersion()} pid ${process.pid}`);
  process.on("uncaughtException", (e) => write(`uncaught error: ${e?.stack ?? String(e)}`));
  process.on("unhandledRejection", (e) => write(`unhandled promise: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`.slice(0, 4000)));
  app.on("child-process-gone", (_e, d) => write(`helper process ended: ${d.type}${d.name ? ` (${d.name})` : ""} ${d.reason} exit ${d.exitCode}`));
  app.on("render-process-gone", (_e, _w, d) => write(`page process ended: ${d.reason} exit ${d.exitCode}`));
  app.on("before-quit", () => write(`quit asked by:${(new Error().stack ?? "").split("\n").slice(2, 8).join(" <")}`));
  process.on("exit", (code) => write(`exit ${code}`));
  return write;
}

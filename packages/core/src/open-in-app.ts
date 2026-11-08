import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

/**
 * Opening a file in another app on this computer, for plugins that work
 * with one (the image editor's "Open in Affinity"). Only apps KesherAI knows
 * are offered, never a command a plugin chooses.
 */

/** Where Affinity (the free 2025 app by Canva, or Affinity Photo 1 and 2) is, on Windows. */
async function affinityOnWindows(own?: string): Promise<string | undefined> {
  if (own && existsSync(own)) return own;
  const roots = [process.env.ProgramFiles ?? "C:\\Program Files", process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "Programs") : ""].filter(Boolean);
  for (const root of roots) {
    const base = join(root, "Affinity");
    if (!existsSync(base)) continue;
    // Affinity\Affinity\Affinity.exe (2025), Affinity\Photo 2\Photo.exe, Affinity\Photo\Photo.exe …
    const dirs = await readdir(base, { withFileTypes: true }).catch(() => []);
    const order = (n: string) => (/^affinity$/i.test(n) ? 0 : /photo 2/i.test(n) ? 1 : /photo/i.test(n) ? 2 : 3);
    for (const d of dirs.filter((x) => x.isDirectory()).sort((a, b) => order(a.name) - order(b.name))) {
      for (const exe of ["Affinity.exe", "Photo.exe", `${d.name}.exe`]) {
        const p = join(base, d.name, exe);
        if (existsSync(p)) return p;
      }
    }
  }
  return undefined;
}

/** Affinity's app name on a Mac, if it is installed. */
function affinityOnMac(): string | undefined {
  return ["Affinity", "Affinity Photo 2", "Affinity Photo"].find((n) => existsSync(`/Applications/${n}.app`));
}

/**
 * Whether Affinity is installed, and where.
 *
 * @param own - A path the user set (Windows), tried first.
 * @returns The program (Windows) or app name (macOS), or undefined.
 */
export async function findAffinity(own?: string): Promise<string | undefined> {
  if (process.platform === "win32") return affinityOnWindows(own);
  if (process.platform === "darwin") return affinityOnMac();
  return undefined;
}

/**
 * Opens a file in Affinity, or in the app the system uses for it when
 * Affinity is not installed.
 *
 * @param file - The file.
 * @param own - A path to Affinity the user set.
 * @returns Which app opened it.
 */
export async function openInAffinity(file: string, own?: string): Promise<{ app: "affinity" | "default" }> {
  const found = await findAffinity(own);
  const run = (cmd: string, args: string[]) => spawn(cmd, args, { detached: true, stdio: "ignore", windowsHide: true }).unref();
  if (process.platform === "win32") {
    if (found) run(found, [file]);
    else run("explorer.exe", [file]);
  } else if (process.platform === "darwin") {
    run("open", found ? ["-a", found, file] : [file]);
  } else run("xdg-open", [file]);
  return { app: found ? "affinity" : "default" };
}

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";

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

/**
 * Shows a file in the computer's file manager (Explorer, Finder, or the folder on Linux). Only called with a path the
 * server itself made (a finished download's destination), never one a client typed.
 *
 * @param file - The file to show.
 */
export function showInFolder(file: string): void {
  const run = (cmd: string, args: string[]) => spawn(cmd, args, { detached: true, stdio: "ignore", windowsHide: true }).on("error", () => undefined).unref();
  if (process.platform === "win32") run("explorer.exe", [`/select,${file}`]);
  else if (process.platform === "darwin") run("open", ["-R", file]);
  else run("xdg-open", [dirname(file)]);
}

/** Where Blender is: the newest under Program Files (Windows), the app (macOS), or `blender` on the PATH (Linux). */
export async function findBlender(): Promise<string | undefined> {
  if (process.platform === "win32") {
    const base = join(process.env.ProgramFiles ?? "C:\\Program Files", "Blender Foundation");
    const dirs = (await readdir(base, { withFileTypes: true }).catch(() => [])).filter((d) => d.isDirectory() && /^blender/i.test(d.name));
    // "Blender 4.5", "Blender 5.0"…: the newest first.
    const ver = (n: string) => (n.match(/\d+(\.\d+)?/)?.[0] ?? "0").split(".").map(Number);
    dirs.sort((a, b) => { const x = ver(a.name), y = ver(b.name); return (y[0] ?? 0) - (x[0] ?? 0) || (y[1] ?? 0) - (x[1] ?? 0); });
    for (const d of dirs) if (existsSync(join(base, d.name, "blender.exe"))) return join(base, d.name, "blender.exe");
    return undefined;
  }
  if (process.platform === "darwin") return existsSync("/Applications/Blender.app/Contents/MacOS/Blender") ? "/Applications/Blender.app/Contents/MacOS/Blender" : undefined;
  for (const dir of (process.env.PATH ?? "").split(":")) if (dir && existsSync(join(dir, "blender"))) return join(dir, "blender");
  return undefined;
}

/**
 * Blender's start-up script for a round trip: an empty scene, the GLB imported, and every save (Ctrl+S) also writes
 * the scene back over the same GLB, so the 3D editor sees the change. The file comes in an environment variable, so
 * no path is ever written into the script.
 */
export const BLENDER_ROUND_TRIP = [
  "import bpy, os",
  "f = os.environ['KESHER_GLB']",
  "bpy.ops.wm.read_factory_settings(use_empty=True)",
  "bpy.ops.import_scene.gltf(filepath=f)",
  "bpy.ops.wm.save_as_mainfile(filepath=os.path.splitext(f)[0] + '.blend')",
  "def back(*_):",
  "    bpy.ops.export_scene.gltf(filepath=f, export_format='GLB')",
  "bpy.app.handlers.save_post.append(back)",
].join("\n");

/**
 * Opens a GLB in Blender for a round trip (see BLENDER_ROUND_TRIP).
 *
 * @param file - The .glb (in the plugin's own folder).
 * @returns Whether Blender was found and started.
 */
export async function openInBlender(file: string): Promise<{ app: "blender" | "none" }> {
  const exe = await findBlender();
  if (!exe) return { app: "none" };
  spawn(exe, ["--python-expr", BLENDER_ROUND_TRIP], { detached: true, stdio: "ignore", windowsHide: false, env: { ...process.env, KESHER_GLB: file } }).unref();
  return { app: "blender" };
}

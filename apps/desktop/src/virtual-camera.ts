/**
 * The avatar camera without OBS (Windows): softcam's "DirectShow Softcam" device, fed by kesher-cam.exe (both built
 * by the release workflow into resources/softcam). The avatar page (#/avatar-feed) is drawn off screen at 1280 x 720,
 * 30 times a second, and each frame goes to kesher-cam.exe as BGR. Making the camera known to Windows (registering
 * softcam.dll) needs the person's yes in Windows' own administrator prompt, once.
 */
import { app, BrowserWindow, type NativeImage } from "electron";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const W = 1280;
const H = 720;

/** What the avatar camera can do now. */
export interface VirtualCameraStatus {
  /** This system has the camera (Windows, with the files). */
  available: boolean;
  /** Windows knows the camera (registered once). */
  installed: boolean;
  running: boolean;
}

/**
 * BGRA (Electron's bitmap) to BGR, top row first (softcam's frame).
 *
 * @param bgra - W × H × 4 bytes.
 * @returns W × H × 3 bytes.
 */
export function bgraToBgr(bgra: Buffer): Buffer {
  const n = bgra.length / 4;
  const out = Buffer.allocUnsafe(n * 3);
  for (let i = 0, j = 0; i < bgra.length; i += 4, j += 3) {
    out[j] = bgra[i]!;
    out[j + 1] = bgra[i + 1]!;
    out[j + 2] = bgra[i + 2]!;
  }
  return out;
}

/**
 * The avatar camera.
 *
 * @param resources - The app's resources folder.
 * @param feedUrl - The avatar page's address.
 */
export function virtualCamera(resources: string, feedUrl: () => string) {
  const dir = join(resources, "softcam");
  const exe = join(dir, "kesher-cam.exe");
  const flag = () => join(app.getPath("userData"), "softcam-installed.json");
  let proc: ChildProcess | undefined;
  let win: BrowserWindow | undefined;

  const available = () => process.platform === "win32" && existsSync(exe) && existsSync(join(dir, "softcam.dll"));
  const installed = async () => !!(await readFile(flag(), "utf8").catch(() => ""));

  const stop = () => {
    win?.destroy();
    win = undefined;
    proc?.stdin?.end();
    proc = undefined;
  };

  return {
    async status(): Promise<VirtualCameraStatus> {
      return { available: available(), installed: available() && (await installed()), running: !!proc };
    },

    /** Registers the camera with Windows; Windows asks the person (administrator prompt). */
    async install(): Promise<void> {
      if (!available()) throw new Error("The avatar camera is only in the Windows app.");
      const installer = join(dir, "softcam_installer.exe");
      // Start-Process -Verb RunAs is how a program asks Windows for the administrator prompt.
      const ps = `$p = Start-Process -FilePath '${installer.replace(/'/g, "''")}' -ArgumentList 'register','"${join(dir, "softcam.dll").replace(/'/g, "''")}"' -Verb RunAs -Wait -PassThru; exit $p.ExitCode`;
      const code = await new Promise<number>((res) => {
        const p = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { windowsHide: true });
        p.on("exit", (c) => res(c ?? 1));
        p.on("error", () => res(1));
      });
      if (code !== 0) throw new Error("The camera was not added (the administrator prompt was declined, or it failed).");
      await writeFile(flag(), JSON.stringify({ at: Date.now() }));
    },

    /** Starts sending the avatar to the camera. */
    async start(): Promise<void> {
      if (proc) return;
      if (!available()) throw new Error("The avatar camera is only in the Windows app.");
      if (!(await installed())) throw new Error("Add the camera to Windows first.");
      const p = spawn(exe, [], { windowsHide: true, stdio: ["pipe", "ignore", "pipe"] });
      proc = p;
      p.on("exit", () => {
        if (proc === p) stop();
      });
      p.stdin?.on("error", () => undefined);
      const w = new BrowserWindow({ show: false, width: W, height: H, useContentSize: true, webPreferences: { offscreen: true, backgroundThrottling: false } });
      win = w;
      w.webContents.setFrameRate(30);
      let blocked = false;
      w.webContents.on("paint", (_e, _dirty, image: NativeImage) => {
        if (!proc?.stdin || blocked) return;
        const size = image.getSize();
        const img = size.width === W && size.height === H ? image : image.resize({ width: W, height: H });
        // When the camera is slower than the page, frames are dropped rather than queued.
        blocked = !proc.stdin.write(bgraToBgr(img.toBitmap()));
        if (blocked) proc.stdin.once("drain", () => (blocked = false));
      });
      await w.loadURL(feedUrl());
    },

    stop,
  };
}

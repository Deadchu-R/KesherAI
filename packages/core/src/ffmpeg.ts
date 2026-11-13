import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { DownloadManager } from "@kesher/downloads";
import { extractArchive, waitForDownload } from "./llamacpp.js";

const run = promisify(execFile);

/**
 * FFmpeg, which reading a video's sound (and most audio types) needs. The one already on the computer is used;
 * otherwise KesherAI downloads a ready-made build once, into its own engines folder (it shows in Downloads),
 * as it does for llama.cpp. Builds: BtbN's FFmpeg-Builds on GitHub (Windows and Linux, x64 and arm64).
 * A Mac without FFmpeg is told to install it (`brew install ffmpeg`).
 */
const BUILDS: Record<string, string> = {
  "win32-x64": "ffmpeg-master-latest-win64-gpl.zip",
  "win32-arm64": "ffmpeg-master-latest-winarm64-gpl.zip",
  "linux-x64": "ffmpeg-master-latest-linux64-gpl.tar.xz",
  "linux-arm64": "ffmpeg-master-latest-linuxarm64-gpl.tar.xz",
};
const BASE = "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/";

let installing: Promise<string> | undefined;

async function works(cmd: string): Promise<boolean> {
  return run(cmd, ["-version"], { timeout: 10_000, windowsHide: true }).then(() => true, () => false);
}

async function findExe(dir: string, name: string): Promise<string | undefined> {
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const full = join(dir, e.name);
    if (e.isFile() && e.name.toLowerCase() === name) return full;
    if (e.isDirectory()) {
      const found = await findExe(full, name);
      if (found) return found;
    }
  }
  return undefined;
}

/**
 * @param o.dir - KesherAI's engines folder.
 * @param o.downloads - The download queue (the download shows there).
 * @returns The FFmpeg program to run.
 */
export async function ensureFfmpeg(o: { dir: string; downloads: DownloadManager }): Promise<string> {
  if (await works("ffmpeg")) return "ffmpeg";
  const exe = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
  const home = join(o.dir, "ffmpeg");
  const have = existsSync(home) ? await findExe(home, exe) : undefined;
  if (have && (await works(have))) return have;
  const build = BUILDS[`${process.platform}-${process.arch}`];
  if (!build) throw new Error(process.platform === "darwin" ? "Reading this file needs FFmpeg. Install it (brew install ffmpeg), then try again." : `Reading this file needs FFmpeg, and there is no ready-made build for ${process.platform}/${process.arch}. Install FFmpeg, then try again.`);
  installing ??= (async () => {
    await rm(home, { recursive: true, force: true });
    await mkdir(home, { recursive: true });
    const archive = join(home, build);
    const job = o.downloads.enqueue({ url: BASE + build, dest: archive, label: "FFmpeg (reads the sound of videos)" });
    await waitForDownload(o.downloads, job.id);
    await extractArchive(archive, home);
    await rm(archive, { force: true });
    const found = await findExe(home, exe);
    if (!found) throw new Error("The FFmpeg download did not contain the program.");
    if (process.platform !== "win32") await chmod(found, 0o755);
    return found;
  })().finally(() => {
    installing = undefined;
  });
  return installing;
}

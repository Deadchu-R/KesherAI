import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync } from "node:fs";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DownloadManager } from "@kesher/downloads";
import { extractArchive, waitForDownload } from "./llamacpp.js";

/**
 * "Access from anywhere": a Cloudflare quick tunnel.
 *
 * KesherAI downloads Cloudflare's `cloudflared` program (Apache-2.0) the
 * first time and runs `cloudflared tunnel --url http://127.0.0.1:<port>`.
 * Cloudflare gives a random `https://….trycloudflare.com` address that
 * reaches this computer from any network, with no router setup and no
 * account. The address changes every time the tunnel starts, so cloudflared
 * runs on its own (detached) and is kept running when KesherAI restarts for
 * an update: the new KesherAI takes it over, and the phone's link keeps
 * working.
 *
 * Everything that arrives through it is treated as remote: it needs the
 * token for every `/api` and `/v1` request (see `isLocalRequest`).
 */

/** What the UI shows. */
export interface TunnelStatus {
  installed: boolean;
  running: boolean;
  /** The public https address, once Cloudflare has given one. */
  url?: string;
  /** What is happening, e.g. "Downloading cloudflared…". */
  message?: string;
  error?: string;
}

const RELEASES = "https://github.com/cloudflare/cloudflared/releases/latest/download";

/**
 * The cloudflared download for this computer.
 *
 * @param platform - `process.platform`.
 * @param arch - `process.arch`.
 * @returns The release file name and whether it is an archive.
 */
export function cloudflaredAsset(platform: string, arch: string): { file: string; archive: boolean } {
  const a = arch === "arm64" ? "arm64" : arch === "arm" ? "arm" : arch === "ia32" ? "386" : "amd64";
  if (platform === "win32") return { file: `cloudflared-windows-${a === "arm64" ? "amd64" : a}.exe`, archive: false };
  if (platform === "darwin") return { file: `cloudflared-darwin-${a === "arm64" ? "arm64" : "amd64"}.tgz`, archive: true };
  return { file: `cloudflared-linux-${a}`, archive: false };
}

/** Finds the trycloudflare.com address in cloudflared's log. */
export function tunnelUrlFrom(line: string): string | undefined {
  // Quick-tunnel names are several words joined by hyphens; api.trycloudflare.com (in error lines) is not one.
  return /https:\/\/[a-z0-9]+(?:-[a-z0-9]+)+\.trycloudflare\.com/i.exec(line)?.[0];
}

/** cloudflared's message when Cloudflare cannot be reached. */
export function tunnelFailureFrom(line: string): string | undefined {
  const m = /failed to request quick Tunnel:?(.*)/i.exec(line);
  return m ? `Could not reach Cloudflare${m[1] ? `: ${m[1].trim()}` : ""}. Check the internet connection, a VPN or a firewall.` : undefined;
}

/** Whether a process is still running. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Runs and watches the cloudflared process. */
export class Tunnel {
  private child?: ChildProcess;
  /** A cloudflared left running by the KesherAI before a restart, taken over. */
  private adopted?: { pid: number; watch: NodeJS.Timeout };
  private state: TunnelStatus;
  private readonly exe: string;

  /**
   * @param dir - Folder for the cloudflared program (inside KesherAI's engines folder).
   * @param downloads - The download queue (so progress shows in the downloads list).
   */
  constructor(
    private readonly dir: string,
    private readonly downloads: DownloadManager,
  ) {
    this.exe = join(dir, process.platform === "win32" ? "cloudflared.exe" : "cloudflared");
    this.state = { installed: existsSync(this.exe), running: false };
  }

  /** @returns The current state. */
  status(): TunnelStatus {
    return { ...this.state, installed: existsSync(this.exe), running: !!this.child || !!this.adopted };
  }

  private async install(): Promise<void> {
    if (existsSync(this.exe)) return;
    await mkdir(this.dir, { recursive: true });
    const asset = cloudflaredAsset(process.platform, process.arch);
    const dest = asset.archive ? join(this.dir, asset.file) : this.exe;
    this.state.message = "Downloading cloudflared (about 60 MB)…";
    const job = this.downloads.enqueue({ url: `${RELEASES}/${asset.file}`, dest, label: `Cloudflare tunnel · ${asset.file}` });
    await waitForDownload(this.downloads, job.id);
    if (asset.archive) {
      await extractArchive(dest, this.dir);
      await rm(dest, { force: true });
    }
    if (process.platform !== "win32") await chmod(this.exe, 0o755);
  }

  private get stateFile(): string {
    return join(this.dir, "running.json");
  }

  /** Takes over the cloudflared that the KesherAI before a restart left running, if it is still there. */
  private adopt(port: number): string | undefined {
    try {
      const j = JSON.parse(readFileSync(this.stateFile, "utf8")) as { pid: number; url: string; port: number };
      if (j.port !== port || !j.url || !alive(j.pid)) return undefined;
      const watch = setInterval(() => {
        if (this.adopted && !alive(this.adopted.pid)) {
          clearInterval(this.adopted.watch);
          this.adopted = undefined;
          this.state = { installed: true, running: false, error: "The tunnel stopped. Turn it on again." };
        }
      }, 30_000);
      watch.unref();
      this.adopted = { pid: j.pid, watch };
      this.state = { installed: true, running: true, url: j.url };
      return j.url;
    } catch {
      return undefined;
    }
  }

  /**
   * Installs cloudflared if needed and starts the tunnel to the local server.
   *
   * @param port - KesherAI's port.
   * @returns The public address.
   * @throws Error if the download fails or Cloudflare gives no address within a minute.
   */
  async start(port: number): Promise<string> {
    if ((this.child || this.adopted) && this.state.url) return this.state.url;
    const kept = this.adopt(port);
    if (kept) return kept;
    this.state = { installed: existsSync(this.exe), running: false };
    try {
      await this.install();
      this.state.message = "Connecting to Cloudflare…";
      // Detached, logging to a file: it outlives a restart of KesherAI (see `detach`).
      const log = join(this.dir, "cloudflared.log");
      const fd = openSync(log, "w");
      const child = spawn(this.exe, ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${port}`], { windowsHide: true, detached: true, stdio: ["ignore", fd, fd] });
      closeSync(fd);
      this.child = child;
      const url = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => {
          clearInterval(poll);
          reject(new Error("Cloudflare did not answer within a minute. Check the internet connection and try again."));
        }, 60_000);
        const poll = setInterval(() => {
          let text = "";
          try {
            text = readFileSync(log, "utf8");
          } catch {
            return;
          }
          const found = tunnelUrlFrom(text);
          const failed = tunnelFailureFrom(text);
          if (found || failed) {
            clearTimeout(timer);
            clearInterval(poll);
            if (found) resolve(found);
            else reject(new Error(failed));
          }
        }, 300);
        child.on("error", (err) => {
          clearInterval(poll);
          clearTimeout(timer);
          reject(err);
        });
        child.on("exit", (code) => {
          clearTimeout(timer);
          clearInterval(poll);
          reject(new Error(`cloudflared stopped (exit code ${code}).`));
        });
      });
      child.on("exit", () => {
        if (this.child === child) {
          this.child = undefined;
          this.state = { installed: true, running: false, error: "The tunnel stopped. Turn it on again." };
        }
      });
      this.state = { installed: true, running: true, url };
      if (child.pid) await writeFile(this.stateFile, JSON.stringify({ pid: child.pid, url, port })).catch(() => undefined);
      return url;
    } catch (err) {
      this.child?.kill();
      this.child = undefined;
      this.state = { installed: existsSync(this.exe), running: false, error: err instanceof Error ? err.message : String(err) };
      throw err;
    }
  }

  /** Stops the tunnel. */
  stop(): void {
    const c = this.child;
    this.child = undefined;
    c?.kill();
    if (this.adopted) {
      clearInterval(this.adopted.watch);
      try {
        process.kill(this.adopted.pid);
      } catch {
        // already gone
      }
      this.adopted = undefined;
    }
    void rm(this.stateFile, { force: true }).catch(() => undefined);
    this.state = { installed: existsSync(this.exe), running: false };
  }

  /**
   * Leaves the tunnel running for the next KesherAI (a restart, an update):
   * the address stays the same, so the phone reconnects through it.
   */
  detach(): void {
    this.child?.unref();
    this.child = undefined;
    if (this.adopted) clearInterval(this.adopted.watch);
    this.adopted = undefined;
  }
}

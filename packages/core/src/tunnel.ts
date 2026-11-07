import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, rm } from "node:fs/promises";
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
 * account. The address changes every time the tunnel starts.
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

/** Runs and watches the cloudflared process. */
export class Tunnel {
  private child?: ChildProcess;
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
    return { ...this.state, installed: existsSync(this.exe), running: !!this.child };
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

  /**
   * Installs cloudflared if needed and starts the tunnel to the local server.
   *
   * @param port - KesherAI's port.
   * @returns The public address.
   * @throws Error if the download fails or Cloudflare gives no address within a minute.
   */
  async start(port: number): Promise<string> {
    if (this.child && this.state.url) return this.state.url;
    this.state = { installed: existsSync(this.exe), running: false };
    try {
      await this.install();
      this.state.message = "Connecting to Cloudflare…";
      const child = spawn(this.exe, ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${port}`], { windowsHide: true });
      this.child = child;
      const url = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Cloudflare did not answer within a minute. Check the internet connection and try again.")), 60_000);
        const onData = (b: Buffer) => {
          const text = b.toString();
          const found = tunnelUrlFrom(text);
          const failed = tunnelFailureFrom(text);
          if (found) {
            clearTimeout(timer);
            resolve(found);
          } else if (failed) {
            clearTimeout(timer);
            reject(new Error(failed));
          }
        };
        child.stdout?.on("data", onData);
        child.stderr?.on("data", onData);
        child.on("error", (err) => {
          clearTimeout(timer);
          reject(err);
        });
        child.on("exit", (code) => {
          clearTimeout(timer);
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
    this.state = { installed: existsSync(this.exe), running: false };
  }
}

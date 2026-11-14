/**
 * Tor for blocked sites (asked for after a news site was blocked on a family computer): KesherAI downloads Tor's
 * own "expert bundle" from torproject.org once (the user presses Install), checks its SHA-256 against Tor's list,
 * and starts it only when a page does not open directly; it stops after 15 idle minutes. Pages read this way say
 * so. A chat can switch it off (its web settings).
 */
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fetchViaSocks, type ProxiedPage } from "./socks-fetch.js";

/** Tor's name for this computer's bundle, or undefined where it has none. */
export function torPlatform(platform = process.platform, arch = process.arch): string | undefined {
  if (platform === "win32" && arch === "x64") return "windows-x86_64";
  if (platform === "linux" && arch === "x64") return "linux-x86_64";
  if (platform === "darwin") return arch === "arm64" ? "macos-aarch64" : "macos-x86_64";
  return undefined;
}

/** The SHA-256 of a file in Tor's `sha256sums-signed-build.txt`. */
export function sumFor(list: string, file: string): string | undefined {
  for (const line of list.split(/\r?\n/)) {
    const m = /^([0-9a-f]{64})\s+\*?(\S+)$/.exec(line.trim());
    if (m && m[2] === file) return m[1];
  }
  return undefined;
}

/** What the settings show. */
export interface TorStatus {
  installed: boolean;
  version?: string;
  running: boolean;
  /** Install or start progress, or the last error. */
  job?: { state: "downloading" | "installing" | "starting" | "error"; message: string };
  available: boolean;
}

const PORT = 9159;

/** Downloads, starts and stops Tor, and reads pages through it. */
export class Tor {
  private proc: ChildProcess | undefined;
  private ready: Promise<void> | undefined;
  private idle: ReturnType<typeof setTimeout> | undefined;
  private job: TorStatus["job"];

  /** @param dir - Where Tor is kept (KesherAI's engines folder). */
  constructor(private dir: string) {}

  private get exe(): string {
    return join(this.dir, "tor", process.platform === "win32" ? "tor.exe" : "tor");
  }

  /** Whether Tor is downloaded. */
  installed(): boolean {
    return existsSync(this.exe);
  }

  /** Installed, version, running, and the current job. */
  async status(): Promise<TorStatus> {
    const version = await readFile(join(this.dir, "version.txt"), "utf8").then((t) => t.trim(), () => undefined);
    return { installed: this.installed(), ...(version ? { version } : {}), running: !!this.proc && !this.proc.killed, ...(this.job ? { job: this.job } : {}), available: !!torPlatform() };
  }

  /** Downloads the newest Tor expert bundle from torproject.org and checks it. */
  async install(): Promise<void> {
    const plat = torPlatform();
    if (!plat) throw new Error("Tor has no ready build for this computer.");
    this.job = { state: "downloading", message: "Finding the newest Tor…" };
    try {
      const list = (await (await fetch("https://aus1.torproject.org/torbrowser/update_3/release/downloads.json")).json()) as { version?: string };
      const v = String(list.version ?? "");
      if (!/^[\d.]+$/.test(v)) throw new Error("Could not read Tor's version list.");
      const file = `tor-expert-bundle-${plat}-${v}.tar.gz`;
      const base = `https://dist.torproject.org/torbrowser/${v}/`;
      this.job = { state: "downloading", message: `Downloading Tor ${v}…` };
      const [sums, data] = await Promise.all([fetch(`${base}sha256sums-signed-build.txt`).then((r) => r.text()), fetch(`${base}${file}`).then(async (r) => (r.ok ? Buffer.from(await r.arrayBuffer()) : Promise.reject(new Error(`Download failed (${r.status}).`))))]);
      const want = sumFor(sums, file);
      const got = createHash("sha256").update(data).digest("hex");
      if (!want || want !== got) throw new Error("The download does not match Tor's published checksum; nothing was installed.");
      this.job = { state: "installing", message: "Unpacking…" };
      await this.stop();
      await rm(this.dir, { recursive: true, force: true });
      await mkdir(this.dir, { recursive: true });
      const archive = join(this.dir, file);
      await writeFile(archive, data);
      await new Promise<void>((resolve, reject) => execFile("tar", ["-xzf", archive, "-C", this.dir], { windowsHide: true }, (err) => (err ? reject(new Error(`Could not unpack Tor: ${err.message}`)) : resolve())));
      await rm(archive, { force: true });
      if (!this.installed()) throw new Error("Tor was unpacked but its program is missing.");
      await writeFile(join(this.dir, "version.txt"), v);
      this.job = undefined;
    } catch (err) {
      this.job = { state: "error", message: (err as Error).message };
      throw err;
    }
  }

  /** Deletes Tor. */
  async remove(): Promise<void> {
    await this.stop();
    await rm(this.dir, { recursive: true, force: true });
    this.job = undefined;
  }

  /** Starts Tor (once) and waits until it has built its circuits. */
  private start(): Promise<void> {
    if (this.ready && this.proc && !this.proc.killed) return this.ready;
    if (!this.installed()) return Promise.reject(new Error("Tor is not installed (Settings → web, or the chat's web settings)."));
    this.job = { state: "starting", message: "Connecting to Tor…" };
    const env = process.platform === "linux" ? { ...process.env, LD_LIBRARY_PATH: join(this.dir, "tor") } : process.env;
    const p = spawn(this.exe, ["--SocksPort", `127.0.0.1:${PORT}`, "--DataDirectory", join(this.dir, "state"), "--ClientOnly", "1", "--Log", "notice stdout"], { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    this.proc = p;
    this.ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Tor did not connect within 90 seconds.")), 90_000);
      p.stdout!.on("data", (d: Buffer) => {
        if (/Bootstrapped 100%/.test(d.toString())) {
          clearTimeout(timer);
          this.job = undefined;
          resolve();
        }
      });
      p.once("exit", (code) => {
        clearTimeout(timer);
        this.proc = undefined;
        this.ready = undefined;
        reject(new Error(`Tor stopped (${code}).`));
      });
      p.once("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
    });
    this.ready.catch((e: Error) => {
      this.job = { state: "error", message: e.message };
      void this.stop();
    });
    return this.ready;
  }

  /** Stops Tor. */
  async stop(): Promise<void> {
    clearTimeout(this.idle);
    this.proc?.kill();
    this.proc = undefined;
    this.ready = undefined;
  }

  /** Reads a page through Tor (starting it if needed); Tor stops after 15 idle minutes. */
  async fetch(url: string, signal?: AbortSignal): Promise<ProxiedPage> {
    await this.start();
    clearTimeout(this.idle);
    try {
      return await fetchViaSocks({ host: "127.0.0.1", port: PORT }, url, AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(60_000)]));
    } finally {
      this.idle = setTimeout(() => void this.stop(), 15 * 60_000);
    }
  }
}

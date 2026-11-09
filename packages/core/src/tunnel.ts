import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync } from "node:fs";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Tailscale } from "./tailscale.js";
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

/** Which internet link (config.remote.anywhereMode). */
export type AnywhereMode = "quick" | "cloudflare" | "tailscale";

/** What the UI shows. */
export interface TunnelStatus {
  /** Which kind of link this is; "quick" changes address each time it starts, the others keep theirs. */
  mode?: AnywhereMode;
  /** The user's own Cloudflare: signed in (a cert.pem exists), the address, and the sign-in page while signing in. */
  cloudflare?: { signedIn: boolean; hostname?: string; ready: boolean; loginUrl?: string };
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
    private readonly opts: {
      mode?: () => AnywhereMode;
      named?: () => { hostname?: string; tunnelId?: string };
      saveNamed?: (n: { hostname?: string; tunnelId?: string }) => Promise<void>;
      tailscale?: Tailscale;
      tailscaleTarget?: () => Promise<string | undefined>;
    } = {},
  ) {
    this.exe = join(dir, process.platform === "win32" ? "cloudflared.exe" : "cloudflared");
    this.state = { installed: existsSync(this.exe), running: false };
  }

  /** @returns The current state. */
  status(): TunnelStatus {
    const mode = this.opts.mode?.() ?? "quick";
    const n = this.opts.named?.() ?? {};
    return {
      ...this.state,
      mode,
      installed: existsSync(this.exe),
      running: !!this.child || !!this.adopted || this.funnelOn,
      cloudflare: { signedIn: existsSync(this.cert), ready: !!(n.tunnelId && n.hostname && existsSync(this.credsOf(n.tunnelId))), ...(n.hostname ? { hostname: n.hostname } : {}), ...(this.loginUrl ? { loginUrl: this.loginUrl } : {}) },
    };
  }

  /** Tailscale Funnel is passing the internet to KesherAI (mode "tailscale"). */
  private funnelOn = false;
  private loginUrl?: string;
  private loginChild?: ChildProcess;
  /** Where `cloudflared tunnel login` keeps the account's certificate. */
  private get cert(): string {
    return join(homedir(), ".cloudflared", "cert.pem");
  }
  private credsOf(id: string): string {
    return join(homedir(), ".cloudflared", `${id}.json`);
  }

  /** Runs cloudflared once and returns what it printed. */
  private runCloudflared(args: string[], timeoutMs = 120_000): Promise<{ code: number; out: string }> {
    return new Promise((res) => {
      const child = spawn(this.exe, args, { windowsHide: true });
      let out = "";
      child.stdout?.on("data", (d) => (out += d));
      child.stderr?.on("data", (d) => (out += d));
      const timer = setTimeout(() => child.kill(), timeoutMs);
      child.on("error", (e) => {
        clearTimeout(timer);
        res({ code: -1, out: `${out}${e.message}` });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        res({ code: code ?? -1, out });
      });
    });
  }

  /**
   * The user's own Cloudflare, step 1: signs in. Returns Cloudflare's page to open (on any device, the
   * phone too); cloudflared waits until the user picks the domain there, then keeps a certificate.
   *
   * @returns The page to open, or nothing when already signed in.
   */
  async cloudflareLogin(): Promise<{ loginUrl?: string; signedIn: boolean }> {
    await this.install();
    if (existsSync(this.cert)) return { signedIn: true };
    // A sign-in already waiting: the same page (one cloudflared at a time).
    if (this.loginChild && this.loginChild.exitCode === null && this.loginUrl) return { loginUrl: this.loginUrl, signedIn: false };
    const child = spawn(this.exe, ["tunnel", "login"], { windowsHide: true, detached: false });
    this.loginChild = child;
    let out = "";
    const url = await new Promise<string | undefined>((res) => {
      const timer = setTimeout(() => res(undefined), 20_000);
      const look = (d: Buffer) => {
        out += d;
        const m = /https:\/\/dash\.cloudflare\.com\/argotunnel\S+/.exec(out);
        if (m) {
          clearTimeout(timer);
          res(m[0]);
        }
      };
      child.stdout?.on("data", look);
      child.stderr?.on("data", look);
      child.on("close", () => {
        clearTimeout(timer);
        res(undefined);
      });
    });
    // It keeps waiting for the sign-in (up to Cloudflare's few minutes), then writes the certificate.
    child.on("close", () => (this.loginUrl = undefined));
    this.loginUrl = url;
    if (!url && !existsSync(this.cert)) throw new Error(`Cloudflare did not give a sign-in page: ${out.slice(-300)}`);
    return { ...(url ? { loginUrl: url } : {}), signedIn: existsSync(this.cert) };
  }

  /**
   * The user's own Cloudflare, step 2: makes a tunnel for KesherAI and points the address at it
   * (a DNS record in the user's domain).
   *
   * @param hostname - e.g. kesher.example.com, in a domain on the user's Cloudflare account.
   */
  async cloudflareSetup(hostname: string): Promise<void> {
    if (!/^(?=.{3,200}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i.test(hostname)) throw new Error("Give an address like kesher.example.com (a domain on your Cloudflare account).");
    if (!existsSync(this.cert)) throw new Error("Sign in to Cloudflare first.");
    await this.install();
    const name = `kesherai-${hostname.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`.slice(0, 60);
    let id: string | undefined;
    const created = await this.runCloudflared(["tunnel", "--no-autoupdate", "create", name]);
    id = /with id ([0-9a-f-]{36})/i.exec(created.out)?.[1];
    if (!id) {
      // It exists already (set up before): find its id.
      const list = await this.runCloudflared(["tunnel", "--no-autoupdate", "list", "--output", "json"]);
      try {
        id = (JSON.parse(list.out.slice(list.out.indexOf("["))) as Array<{ id: string; name: string }>).find((t) => t.name === name)?.id;
      } catch {
        // not JSON
      }
    }
    if (!id) throw new Error(`Cloudflare did not make the tunnel: ${created.out.slice(-300)}`);
    if (!existsSync(this.credsOf(id))) throw new Error(`The tunnel ${name} exists, but its key file is not on this computer (it was made elsewhere). Delete it in Cloudflare (Zero Trust → Networks → Tunnels) and try again.`);
    const route = await this.runCloudflared(["tunnel", "--no-autoupdate", "route", "dns", "--overwrite-dns", id, hostname]);
    if (route.code !== 0 && !/already/i.test(route.out)) throw new Error(`Cloudflare did not point ${hostname} at the tunnel: ${route.out.slice(-300)}`);
    await this.opts.saveNamed?.({ hostname: hostname.toLowerCase(), tunnelId: id });
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
    const mode = this.opts.mode?.() ?? "quick";
    if (mode === "tailscale") return this.startFunnel(port);
    if ((this.child || this.adopted) && this.state.url) return this.state.url;
    const kept = this.adopt(port);
    if (kept) return kept;
    if (mode === "cloudflare") return this.startNamed(port);
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

  /** Tailscale Funnel: the internet reaches KesherAI at the computer's fixed ts.net address. */
  private async startFunnel(port: number): Promise<string> {
    const ts = this.opts.tailscale;
    if (!ts) throw new Error("Tailscale is not available here.");
    const target = await this.opts.tailscaleTarget?.();
    if (!target) throw new Error("Tailscale is not running on this computer, or it is not signed in. Install Tailscale (tailscale.com/download), sign in, and try again.");
    const st = await ts.funnel(port, target);
    if (st.hint || !st.url) {
      this.state = { installed: existsSync(this.exe), running: false, error: st.hint ?? "Tailscale gave no address." };
      throw new Error(this.state.error);
    }
    this.funnelOn = true;
    this.state = { installed: existsSync(this.exe), running: true, url: st.url };
    return st.url;
  }

  /** The user's own Cloudflare tunnel: a fixed address in their domain. */
  private async startNamed(port: number): Promise<string> {
    const n = this.opts.named?.() ?? {};
    if (!n.tunnelId || !n.hostname || !existsSync(this.credsOf(n.tunnelId))) throw new Error("Set up your Cloudflare address first (Settings → Phone → access from anywhere → your own Cloudflare).");
    this.state = { installed: existsSync(this.exe), running: false, message: "Connecting to Cloudflare…" };
    const log = join(this.dir, "cloudflared.log");
    const fd = openSync(log, "w");
    const child = spawn(this.exe, ["tunnel", "--no-autoupdate", "run", "--url", `http://127.0.0.1:${port}`, "--credentials-file", this.credsOf(n.tunnelId), n.tunnelId], { windowsHide: true, detached: true, stdio: ["ignore", fd, fd] });
    closeSync(fd);
    this.child = child;
    const url = `https://${n.hostname}`;
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          clearInterval(poll);
          reject(new Error("Cloudflare did not connect within a minute. Check the internet connection and try again."));
        }, 60_000);
        const poll = setInterval(() => {
          let text = "";
          try {
            text = readFileSync(log, "utf8");
          } catch {
            return;
          }
          if (/Registered tunnel connection/i.test(text)) {
            clearTimeout(timer);
            clearInterval(poll);
            resolve();
          }
        }, 300);
        child.on("exit", (code) => {
          clearTimeout(timer);
          clearInterval(poll);
          reject(new Error(`cloudflared stopped (exit code ${code}).`));
        });
      });
    } catch (err) {
      child.kill();
      this.child = undefined;
      this.state = { installed: true, running: false, error: (err as Error).message };
      throw err;
    }
    child.on("exit", () => {
      if (this.child === child) {
        this.child = undefined;
        this.state = { installed: true, running: false, error: "The tunnel stopped. Turn it on again." };
      }
    });
    this.state = { installed: true, running: true, url };
    if (child.pid) await writeFile(this.stateFile, JSON.stringify({ pid: child.pid, url, port })).catch(() => undefined);
    return url;
  }

  /** Stops the tunnel. */
  stop(): void {
    if (this.funnelOn) {
      this.funnelOn = false;
      void this.opts.tailscale?.funnelOff().catch(() => undefined);
    }
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

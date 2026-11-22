import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { cleanTailscaleDirect, isTailscaleIp, type TailscaleDirect } from "@kesher/shared";

/**
 * HTTPS for remote access through Tailscale: `tailscale serve` gives this
 * computer a real certificate at https://<computer>.<tailnet>.ts.net and
 * passes requests to KesherAI. Only devices in the user's own tailnet can
 * reach it, and they still need the remote-access token (requests through
 * it are not "from this computer").
 *
 * Tailscale Funnel (the same address open to the whole internet) is never turned on unless the user chose it
 * (`remote.allowFunnel`, off by default); a Funnel left on from an older KesherAI is replaced by `serve` at start.
 */

/** What the settings page shows. */
export interface TailscaleHttps {
  installed: boolean;
  running: boolean;
  /** e.g. https://pc.tail1234.ts.net */
  url?: string;
  /** Whether `tailscale serve` passes HTTPS to KesherAI now. */
  on: boolean;
  /** What to do when the tailnet does not allow HTTPS yet (a link from Tailscale). */
  hint?: string;
}

const CANDIDATES = process.platform === "win32" ? ["C:\\Program Files\\Tailscale\\tailscale.exe", "tailscale.exe"] : process.platform === "darwin" ? ["/Applications/Tailscale.app/Contents/MacOS/Tailscale", "/usr/local/bin/tailscale", "/opt/homebrew/bin/tailscale"] : ["/usr/bin/tailscale", "/usr/local/bin/tailscale", "tailscale"];

/** Runs the Tailscale command line. */
export class Tailscale {
  /** @param run - For tests: runs the CLI with arguments and returns stdout (throws with stderr on failure). */
  constructor(private readonly run: (args: string[]) => Promise<string> = defaultRun) {}

  /**
   * @param port - KesherAI's port.
   * @returns Whether HTTPS through Tailscale is possible, and on.
   */
  async status(port: number): Promise<TailscaleHttps> {
    let st: { BackendState?: string; Self?: { DNSName?: string } };
    try {
      st = JSON.parse(await this.run(["status", "--json"])) as typeof st;
    } catch (e) {
      return { installed: !/not found|ENOENT/i.test(String((e as Error).message)), running: false, on: false };
    }
    const dns = st.Self?.DNSName?.replace(/\.$/, "");
    const running = st.BackendState === "Running";
    let on = false;
    try {
      const serve = await this.run(["serve", "status", "--json"]);
      on = new RegExp(`https?://[\\d.]+:${port}|localhost:${port}`).test(serve);
    } catch {
      /* older Tailscale: no serve status */
    }
    return { installed: true, running, on, ...(dns ? { url: `https://${dns}` } : {}) };
  }

  /**
   * This computer in the tailnet: its Tailscale IPv4 address and MagicDNS name (empty when Tailscale is not running).
   *
   * @returns The address and name.
   */
  async self(): Promise<{ ip?: string; dns?: string }> {
    try {
      const st = JSON.parse(await this.run(["status", "--json"])) as { BackendState?: string; Self?: { DNSName?: string; TailscaleIPs?: string[] } };
      if (st.BackendState !== "Running") return {};
      const ip = st.Self?.TailscaleIPs?.find((a) => isTailscaleIp(a));
      const dns = st.Self?.DNSName?.replace(/\.$/, "");
      return { ...(ip ? { ip } : {}), ...(dns ? { dns } : {}) };
    } catch {
      return {};
    }
  }

  /**
   * What the phones are told for the backup path (direct-path.ts): the tailnet-only HTTPS address when `serve`
   * passes it to KesherAI, the 100.x address and the MagicDNS name.
   *
   * @param port - KesherAI's port.
   * @returns The addresses, or undefined when Tailscale is not running.
   */
  async direct(port: number): Promise<TailscaleDirect | undefined> {
    const [me, st] = await Promise.all([this.self(), this.status(port).catch(() => undefined)]);
    return cleanTailscaleDirect({ ...me, ...(st?.on && st.url ? { url: st.url } : {}) });
  }

  /**
   * Whether a Funnel is on (anything in `serve status --json` marked `AllowFunnel`).
   *
   * @returns True when something on this computer is open to the internet through Tailscale.
   */
  async funnelActive(): Promise<boolean> {
    try {
      const j = JSON.parse(await this.run(["serve", "status", "--json"])) as { AllowFunnel?: Record<string, boolean> };
      return Object.values(j?.AllowFunnel ?? {}).some((v) => v === true);
    } catch {
      return false;
    }
  }

  /**
   * Replaces a Funnel left on (by an older KesherAI, which ran `tailscale funnel` at start) with tailnet-only
   * `serve`: turns the Funnel off, then serves KesherAI to the tailnet again when a target is given.
   *
   * @param port - KesherAI's port.
   * @param target - Where serve passes requests (this computer's Tailscale address), or undefined to only turn it off.
   * @returns Whether a Funnel was found and turned off.
   */
  async closeFunnel(port: number, target?: string): Promise<boolean> {
    if (!(await this.funnelActive())) return false;
    await this.funnelOff();
    if (target) await this.enable(port, target);
    return true;
  }

  /**
   * Turns HTTPS on: `tailscale serve --bg --https=443 http://<this computer's Tailscale address>:<port>`.
   * It points at the Tailscale address, not 127.0.0.1, so KesherAI sees
   * these requests as coming from another device (they need the token).
   *
   * @param port - KesherAI's port.
   * @param target - This computer's Tailscale IPv4 address.
   * @returns The new state; `hint` says what to do when the tailnet needs HTTPS turned on first.
   */
  async enable(port: number, target: string): Promise<TailscaleHttps> {
    try {
      await this.run(["serve", "--bg", "--https=443", `http://${target}:${port}`]);
    } catch (e) {
      const msg = (e as Error).message;
      const link = /https:\/\/login\.tailscale\.com\/\S+/.exec(msg)?.[0];
      return { ...(await this.status(port)), hint: link ? `Turn on HTTPS for your tailnet first: ${link}` : msg.slice(0, 400) };
    }
    return this.status(port);
  }

  /**
   * Tailscale Funnel: the same HTTPS address, open to the internet. Only when the user explicitly allowed it
   * (`remote.allowFunnel`); the caller checks. Requests still need a device key or the token.
   *
   * @returns The state; `hint` says what to do when the tailnet does not allow Funnel yet (a link from Tailscale).
   */
  async funnel(port: number, target: string): Promise<TailscaleHttps> {
    try {
      await this.run(["funnel", "--bg", "--https=443", `http://${target}:${port}`]);
    } catch (e) {
      const msg = (e as Error).message;
      const link = /https:\/\/login\.tailscale\.com\/\S+/.exec(msg)?.[0];
      return { ...(await this.status(port)), hint: link ? `Allow Funnel for this computer in Tailscale first (open, approve, then try again): ${link}` : msg.slice(0, 400) };
    }
    return this.status(port);
  }

  /** Stops Funnel (the tailnet-only HTTPS, if on, is turned off too: they share port 443). */
  async funnelOff(): Promise<void> {
    await this.run(["funnel", "--https=443", "off"]).catch(() => undefined);
  }

  /** Turns it off. */
  async disable(port: number): Promise<TailscaleHttps> {
    await this.run(["serve", "--https=443", "off"]).catch(() => undefined);
    return this.status(port);
  }
}

function defaultRun(args: string[]): Promise<string> {
  const exe = CANDIDATES.find((c) => !c.includes("/") && !c.includes("\\") ? true : existsSync(c)) ?? "tailscale";
  return new Promise((ok, fail) => {
    // `serve --bg` with HTTPS off asks to open a link and waits; give up after 20 seconds and show the link.
    execFile(exe, args, { timeout: 20_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) fail(new Error(`${stderr || ""}${stdout || ""}${err.message}`.trim()));
      else ok(stdout.toString());
    });
  });
}

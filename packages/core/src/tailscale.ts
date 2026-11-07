import { execFile } from "node:child_process";
import { existsSync } from "node:fs";

/**
 * HTTPS for remote access through Tailscale: `tailscale serve` gives this
 * computer a real certificate at https://<computer>.<tailnet>.ts.net and
 * passes requests to KesherAI. Only devices in the user's own tailnet can
 * reach it, and they still need the remote-access token (requests through
 * it are not "from this computer").
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

import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const RULE = "KesherAI (phone)";

/** Result of {@link allowThroughFirewall}. */
export type FirewallResult = "added" | "exists" | "declined" | "not-needed";

/**
 * Lets other devices on the home network (and Tailscale) reach KesherAI's
 * port through Windows Firewall. Windows shows its own permission prompt
 * (UAC); nothing changes unless the user clicks Yes. The rule only allows
 * the local network and Tailscale addresses, never the whole internet.
 * On macOS and Linux nothing is needed.
 *
 * @param port - KesherAI's port.
 * @returns What happened.
 */
export async function allowThroughFirewall(port: number): Promise<FirewallResult> {
  if (process.platform !== "win32") return "not-needed";
  const exists = async () =>
    exec("netsh", ["advfirewall", "firewall", "show", "rule", `name=${RULE}`], { windowsHide: true }).then(
      () => true,
      () => false,
    );
  if (await exists()) return "exists";
  const args = `advfirewall firewall add rule name="${RULE}" dir=in action=allow protocol=TCP localport=${port} profile=any remoteip=localsubnet,100.64.0.0/10`;
  await new Promise<void>((resolve) => {
    // Start-Process -Verb RunAs shows the Windows permission prompt and waits for netsh.
    const ps = spawn(
      "powershell",
      ["-NoProfile", "-Command", `Start-Process netsh -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList '${args.replace(/'/g, "''")}'`],
      { windowsHide: true },
    );
    ps.on("exit", () => resolve());
    ps.on("error", () => resolve());
  });
  return (await exists()) ? "added" : "declined";
}

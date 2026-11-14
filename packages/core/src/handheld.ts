/**
 * Which computer this is, to know a handheld gaming PC (ROG Ally, Steam Deck, Legion Go, MSI Claw): KesherAI then
 * gives it the handheld look (larger targets) and says the controller works, as Steam Big Picture and the Xbox app do.
 * Read from the firmware's product name: the registry on Windows (no PowerShell start), /sys/class/dmi on Linux.
 */
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";

/** What is known about this computer's model. */
export interface DeviceInfo {
  /** The maker's product name, as the firmware reports it ("ROG Xbox Ally X RC73XA_RC73XA"). */
  model: string;
  /** A handheld gaming PC's name ("ROG Xbox Ally X"), or undefined for another computer. */
  handheld?: string;
}

/** Product names of handheld gaming PCs, by the firmware's product name or model code. */
const HANDHELDS: Array<[RegExp, string]> = [
  [/RC73XA|Xbox Ally X/i, "ROG Xbox Ally X"],
  [/RC73YA|Xbox Ally\b/i, "ROG Xbox Ally"],
  [/RC72LA|ROG Ally X/i, "ROG Ally X"],
  [/RC71L|ROG Ally/i, "ROG Ally"],
  [/^(Jupiter|Galileo)$/i, "Steam Deck"],
  [/^83E1$|^83L3$|^83N6$|Legion Go/i, "Legion Go"],
  [/Claw/i, "MSI Claw"],
  [/GPD WIN|GPD G1618/i, "GPD Win"],
  [/AYANEO|AIR Plus|KUN\b/i, "AYANEO"],
  [/OneXPlayer|ONEXPLAYER/i, "OneXPlayer"],
];

/**
 * Names a handheld from the firmware's product name.
 *
 * @param model - The product name ("ROG Xbox Ally X RC73XA_RC73XA", "Jupiter").
 */
export function handheldOf(model: string): string | undefined {
  const m = model.trim();
  return HANDHELDS.find(([re]) => re.test(m))?.[1];
}

const run = (cmd: string, args: string[]) =>
  new Promise<string>((done) => {
    execFile(cmd, args, { windowsHide: true, timeout: 5000 }, (err, out) => done(err ? "" : String(out)));
  });

let cached: Promise<DeviceInfo> | undefined;

/** This computer's model and, for a handheld gaming PC, its name (read once). */
export function deviceInfo(): Promise<DeviceInfo> {
  return (cached ??= (async () => {
    let model = "";
    if (process.platform === "win32") {
      const out = await run("reg", ["query", "HKLM\\HARDWARE\\DESCRIPTION\\System\\BIOS", "/v", "SystemProductName"]);
      model = /SystemProductName\s+REG_SZ\s+(.+)/.exec(out)?.[1]?.trim() ?? "";
    } else if (process.platform === "linux") {
      model = (await readFile("/sys/class/dmi/id/product_name", "utf8").catch(() => "")).trim();
    }
    const handheld = handheldOf(model);
    return { model, ...(handheld ? { handheld } : {}) };
  })());
}

/**
 * Games and Store apps that Windows' program list leaves out (PC health → Programs): Steam (its libraries'
 * `appmanifest_*.acf`), Epic (its launcher's `.item` manifests), and Microsoft Store / Xbox apps (Get-AppxPackage;
 * Xbox PC games in `XboxGames` are measured on disk). Read-only: nothing is changed here.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { driveOf } from "./storage.js";

/** A game or Store app. */
export interface FoundApp {
  name: string;
  source: "steam" | "epic" | "store" | "xbox";
  bytes?: number;
  /** Where it is installed. */
  folder?: string;
  /** The drive it is installed on ("C:", "E:"), from its folder or its library. */
  drive?: string;
  /** A link that starts the store's own uninstall (Steam), or opens the store. */
  uninstallUrl?: string;
  lastPlayed?: string;
  /** Steam's app id (Steam only), e.g. "431960" for Wallpaper Engine. */
  steamAppId?: string;
}

/**
 * Reads Valve's KeyValues text (libraryfolders.vdf, appmanifest_*.acf) into nested objects.
 *
 * @param text - The file's text.
 */
export function parseVdf(text: string): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  const stack: Array<Record<string, unknown>> = [root];
  const tokens = text.match(/"(?:[^"\\]|\\.)*"|[{}]/g) ?? [];
  let key: string | undefined;
  for (const t of tokens) {
    const top = stack[stack.length - 1]!;
    if (t === "{") {
      const o: Record<string, unknown> = {};
      if (key !== undefined) top[key] = o;
      stack.push(o);
      key = undefined;
    } else if (t === "}") {
      if (stack.length > 1) stack.pop();
      key = undefined;
    } else {
      const s = t.slice(1, -1).replace(/\\\\/g, "\\");
      if (key === undefined) key = s;
      else {
        top[key] = s;
        key = undefined;
      }
    }
  }
  return root;
}

/**
 * Steam's library folders from libraryfolders.vdf.
 *
 * @param vdf - The file's text.
 */
export function steamLibraries(vdf: string): string[] {
  const lf = (parseVdf(vdf).libraryfolders ?? parseVdf(vdf).LibraryFolders ?? {}) as Record<string, unknown>;
  return Object.values(lf).flatMap((v) => (v && typeof v === "object" && typeof (v as { path?: unknown }).path === "string" ? [(v as { path: string }).path] : []));
}

/**
 * One installed Steam game from its appmanifest.
 *
 * @param acf - The manifest's text.
 * @param library - The library folder it is in.
 */
export function steamGame(acf: string, library: string): FoundApp | undefined {
  const s = (parseVdf(acf).AppState ?? {}) as Record<string, string>;
  if (!s.appid || !s.name) return undefined;
  // Steam's own tools (runtimes, redistributables) are not games the person installed.
  if (/^Steamworks Common Redistributables$|^Steam Linux Runtime|^Proton /i.test(s.name)) return undefined;
  const last = Number(s.LastPlayed ?? 0);
  return {
    name: s.name.slice(0, 200),
    source: "steam",
    ...(Number(s.SizeOnDisk) > 0 ? { bytes: Number(s.SizeOnDisk) } : {}),
    ...(s.installdir ? { folder: join(library, "steamapps", "common", s.installdir) } : {}),
    ...(driveOf(library) ? { drive: driveOf(library)! } : {}),
    uninstallUrl: `steam://uninstall/${encodeURIComponent(s.appid)}`,
    steamAppId: s.appid,
    ...(last > 0 ? { lastPlayed: new Date(last * 1000).toISOString().slice(0, 10) } : {}),
  };
}

/**
 * One installed Epic game from its launcher manifest (.item, JSON).
 *
 * @param json - The manifest's text.
 */
export function epicGame(json: string): FoundApp | undefined {
  try {
    const j = JSON.parse(json) as { DisplayName?: string; InstallSize?: number; InstallLocation?: string; bIsApplication?: boolean; AppCategories?: string[] };
    if (!j.DisplayName || j.bIsApplication === false) return undefined;
    return { name: j.DisplayName.slice(0, 200), source: "epic", ...(j.InstallSize ? { bytes: Number(j.InstallSize) } : {}), ...(j.InstallLocation ? { folder: j.InstallLocation } : {}), ...(driveOf(j.InstallLocation) ? { drive: driveOf(j.InstallLocation)! } : {}), uninstallUrl: "com.epicgames.launcher://store" };
  } catch {
    return undefined;
  }
}

/** The size of a folder (files counted once; stops after 200,000 files). */
async function folderBytes(dir: string): Promise<number> {
  let total = 0;
  let files = 0;
  const walk = async (d: string): Promise<void> => {
    for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) {
      if (files > 200_000) return;
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile()) {
        files++;
        total += (await stat(p).catch(() => undefined))?.size ?? 0;
      }
    }
  };
  await walk(dir);
  return total;
}

const ps = (command: string, timeoutMs = 30_000) =>
  new Promise<string>((done) => execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], { windowsHide: true, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (_e, out) => done(String(out ?? ""))));

/** Games and Store apps on this Windows computer (an empty list elsewhere). */
export async function findGamesAndStoreApps(): Promise<FoundApp[]> {
  if (process.platform !== "win32") return [];
  const out: FoundApp[] = [];
  // Steam: where it is, then every library's manifests.
  const steamPath = (await ps("(Get-ItemProperty 'HKCU:\\Software\\Valve\\Steam' -ErrorAction SilentlyContinue).SteamPath", 10_000)).trim().replace(/\//g, "\\");
  if (steamPath) {
    const vdf = await readFile(join(steamPath, "steamapps", "libraryfolders.vdf"), "utf8").catch(() => "");
    const libs = [...new Set([steamPath, ...steamLibraries(vdf)].map((p) => p.replace(/\//g, "\\")))];
    for (const lib of libs) {
      const dir = join(lib, "steamapps");
      for (const f of (await readdir(dir).catch(() => [])).filter((n) => /^appmanifest_\d+\.acf$/i.test(n))) {
        const g = steamGame(await readFile(join(dir, f), "utf8").catch(() => ""), lib);
        if (g) out.push(g);
      }
    }
  }
  // Epic.
  const epicDir = join(process.env.ProgramData ?? "C:\\ProgramData", "Epic", "EpicGamesLauncher", "Data", "Manifests");
  for (const f of (await readdir(epicDir).catch(() => [])).filter((n) => n.endsWith(".item"))) {
    const g = epicGame(await readFile(join(epicDir, f), "utf8").catch(() => ""));
    if (g) out.push(g);
  }
  // Microsoft Store and Xbox: apps from the Store that the person can remove (not frameworks or system parts).
  const raw = await ps("Get-AppxPackage | Where-Object { -not $_.IsFramework -and -not $_.NonRemovable -and $_.SignatureKind -eq 'Store' } | Select-Object Name,InstallLocation | ConvertTo-Json -Compress", 40_000);
  let rows: Array<{ Name?: string; InstallLocation?: string }> = [];
  try {
    const j = JSON.parse(raw || "[]") as unknown;
    rows = (Array.isArray(j) ? j : [j]) as typeof rows;
  } catch {
    rows = [];
  }
  for (const r of rows) {
    if (!r.Name) continue;
    // Xbox PC games live in X:\XboxGames\<name>\Content, which can be measured; WindowsApps cannot be read.
    const xbox = !!r.InstallLocation && /\\XboxGames\\/i.test(r.InstallLocation);
    const bytes = xbox && existsSync(r.InstallLocation!) ? await folderBytes(r.InstallLocation!) : undefined;
    out.push({ name: r.Name.replace(/^Microsoft\./, "").slice(0, 200), source: xbox ? "xbox" : "store", ...(bytes ? { bytes } : {}), ...(r.InstallLocation ? { folder: r.InstallLocation } : {}), ...(driveOf(r.InstallLocation) ? { drive: driveOf(r.InstallLocation)! } : {}), uninstallUrl: "ms-settings:appsfeatures" });
  }
  return out.sort((a, b) => (b.bytes ?? 0) - (a.bytes ?? 0));
}

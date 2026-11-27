import { execFile } from "node:child_process";
import { resolve, sep } from "node:path";
import type { InboxBusy, InboxSettings } from "@kesher/shared";
import { EDITOR } from "./heavy-folder.js";

/**
 * "Not while the PC is busy" for the task inbox (Settings > Task inbox): Run waits while a game is running, while an
 * editor the user works in is open (Unreal, Unity, Godot, Blender), or while the graphics card has been busy for two
 * minutes. Antigravity works in Google's cloud, so these protect the user's own work (CPU, disk, network), not the card.
 */

/** What the busy check reads. */
export interface BusyInput {
  /** Names of running games (matched by their install folders). */
  games: string[];
  /** Names of running editors. */
  editors: string[];
  /** The busiest card's use now, in percent. */
  gpu?: number;
  /** Since when the card has been above the limit (ms since epoch), if it is. */
  gpuHighSince?: number;
  now: number;
}

/** How long the card must stay busy before it counts. */
export const GPU_BUSY_MS = 2 * 60_000;

/**
 * Whether the PC is free for an inbox run, and why not.
 *
 * @param i - What is running now.
 * @param s - The busy rules.
 */
export function inboxBusy(i: BusyInput, s: Pick<InboxSettings, "notWhileGame" | "notWhileEditor" | "gpuBusyPercent">): InboxBusy {
  const reasons: string[] = [];
  if (s.notWhileGame && i.games.length) reasons.push(`game: ${i.games.slice(0, 2).join(", ")}`);
  if (s.notWhileEditor && i.editors.length) reasons.push(`editor: ${[...new Set(i.editors)].slice(0, 2).join(", ")}`);
  if (s.gpuBusyPercent > 0 && i.gpu !== undefined && i.gpu >= s.gpuBusyPercent && i.gpuHighSince !== undefined && i.now - i.gpuHighSince >= GPU_BUSY_MS) reasons.push(`gpu: ${Math.round(i.gpu)}%`);
  return { free: reasons.length === 0, reasons, ...(i.gpu !== undefined ? { gpu: Math.round(i.gpu) } : {}) };
}

/** A running program: its name and, when the system says, its full path. */
export interface RunningProgram {
  name: string;
  path?: string;
  /** The process id (Windows only), to match the graphics card's per-process list. */
  pid?: number;
}

/**
 * The programs running now (Windows: name and path; elsewhere: the command line's first word).
 *
 * @returns The list (empty when it cannot be read).
 */
export async function runningPrograms(): Promise<RunningProgram[]> {
  const win = process.platform === "win32";
  const [cmd, args] = win
    ? ["powershell", ["-NoProfile", "-Command", "Get-Process | ForEach-Object { \"$($_.ProcessName)`t$($_.Path)`t$($_.Id)\" }"]]
    : ["ps", ["-eo", "args="]];
  const out = await new Promise<string>((ok) => execFile(cmd as string, args as string[], { windowsHide: true, timeout: 20_000, maxBuffer: 8 * 1024 * 1024 }, (_e, stdout) => ok(String(stdout ?? ""))));
  return out
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => {
      if (win) {
        const [name, path, id] = l.split("\t");
        const pid = Number(id);
        return { name: name ?? "", ...(path ? { path } : {}), ...(Number.isInteger(pid) && pid > 0 ? { pid } : {}) };
      }
      const first = l.trim().split(/\s+/)[0] ?? "";
      return { name: first.split("/").pop() ?? first, path: first };
    });
}

/**
 * Games and editors among the running programs.
 *
 * @param programs - From {@link runningPrograms}.
 * @param gameFolders - Install folders of the games found on this PC (pc-games.ts), with their names.
 */
export function busyPrograms(programs: RunningProgram[], gameFolders: Array<{ name: string; folder: string }>): { games: string[]; editors: string[] } {
  const folders = gameFolders.filter((g) => g.folder).map((g) => ({ name: g.name, prefix: resolve(g.folder).toLowerCase() + sep }));
  const games = new Set<string>();
  const editors: string[] = [];
  for (const p of programs) {
    if (EDITOR.test(p.name) && !/hub|helper|crash|service|launcher/i.test(p.name)) editors.push(p.name);
    const path = p.path?.toLowerCase();
    if (path) for (const f of folders) if (path.startsWith(f.prefix)) games.add(f.name);
  }
  return { games: [...games], editors };
}

/**
 * Steam apps that are tools, not games (Steam marks them "Tool" or "Application" in its binary appinfo.vdf, which
 * the scanner does not read; the appmanifest has no type). Wallpaper Engine runs all day, so counting it kept the
 * task inbox paused.
 */
const STEAM_NOT_GAMES = new Set([
  "431960", // Wallpaper Engine
  "250820", // SteamVR
  "228980", // Steamworks Common Redistributables
  "1070560", "1391110", "1628350", // Steam Linux Runtime (scout, soldier, sniper)
  "629520", // Soundpad
  "1905180", // OBS Studio
  "993090", // Lossless Scaling
  "431730", // Aseprite
  "365670", // Blender (counted as an editor instead)
  "404790", // Godot Engine (counted as an editor instead)
]);

/** Names of Steam tools, for ones not in {@link STEAM_NOT_GAMES} (other Proton versions, dedicated servers, SDKs). */
const STEAM_TOOL_NAME = /^(Wallpaper Engine|SteamVR|Proton\b|Steam Linux Runtime|Steamworks\b|Soundpad|OBS Studio|Lossless Scaling)|Dedicated Server$|\bSDK$|Redistributables?$/i;

/**
 * Whether a found app is a Steam tool rather than a game.
 *
 * @param g - One entry from pc-games.ts `findGamesAndStoreApps`.
 */
export function isSteamTool(g: { name: string; source: string; steamAppId?: string }): boolean {
  return g.source === "steam" && ((!!g.steamAppId && STEAM_NOT_GAMES.has(g.steamAppId)) || STEAM_TOOL_NAME.test(g.name.trim()));
}

/**
 * The install folders that count as games for the busy check: Steam, Epic and Xbox PC games only. Plain Microsoft
 * Store apps (Phone Link's "CrossDevice", Photos, …) and Steam tools ({@link isSteamTool}: Wallpaper Engine,
 * SteamVR, …) are not games, and counting them kept the inbox paused.
 *
 * @param found - What pc-games.ts `findGamesAndStoreApps` returned.
 * @returns Name and folder of each game that has a folder.
 */
export function gameFoldersForBusy(found: Array<{ name: string; source: string; folder?: string; steamAppId?: string }>): Array<{ name: string; folder: string }> {
  return found.flatMap((g) => (g.folder && g.source !== "store" && !isSteamTool(g) ? [{ name: g.name, folder: g.folder }] : []));
}

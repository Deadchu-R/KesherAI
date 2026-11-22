/**
 * How the last run ended, for the computer health page (also seen from the phone): the desktop app records at start
 * whether the previous run ended with an exit and its last memory numbers (`logs/last-shutdown.json`); on Windows the
 * System log's last power events (Kernel-Power 41, 1074, 6008) say what the computer itself did. Read only.
 */
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { HeavyLabel } from "./heavy-gate.js";

/** What was recorded about the previous run. */
export interface LastRun {
  /** True when it ended with an exit; false when it just stopped (a crash, power loss, or ended from outside). */
  clean: boolean;
  /** When it was last seen alive (ISO), when known. */
  lastAlive?: string;
  /** Free memory of the computer then, in MB, when known. */
  freeMb?: number;
  /** This app's heap then, in MB (used and total), when known. */
  heapMb?: [number, number];
}

/** One Windows power event. */
export interface PowerEvent {
  id: number;
  at: string;
  /** What it means in plain words. */
  meaning: HeavyLabel;
}

/** What the page shows. */
export interface ShutdownInfo {
  /** Absent when there is no record yet (first run). */
  lastRun?: LastRun;
  /** The sentence for the page, in both languages. */
  line?: HeavyLabel;
  /** Windows only: the newest power events, newest first. */
  windows: PowerEvent[];
}

/**
 * Reads the numbers out of the alive file's text, e.g.
 * `2026-11-22T06:02:00.000Z (pid 1, 40 s after start; this app 1753 MB, heap 457/467 MB, external 1115 MB; computer free 66057 of 95791 MB)`.
 *
 * @param text - The text the desktop app kept.
 * @returns What could be read (empty when nothing).
 */
export function parseAlive(text: string): Omit<LastRun, "clean"> {
  const at = /^(\d{4}-\d\d-\d\dT[\d:.]+Z)/.exec(text.trim())?.[1];
  const heap = /heap (\d+)\/(\d+) MB/.exec(text);
  const free = /computer free (\d+) of/.exec(text);
  return {
    ...(at && !Number.isNaN(Date.parse(at)) ? { lastAlive: at } : {}),
    ...(free ? { freeMb: Number(free[1]) } : {}),
    ...(heap ? { heapMb: [Number(heap[1]), Number(heap[2])] as [number, number] } : {}),
  };
}

/**
 * Reads the desktop app's record of the previous run.
 *
 * @param root - The data folder.
 * @returns The record, or undefined when there is none (first run, a server without the desktop app).
 */
export async function readLastRun(root: string): Promise<LastRun | undefined> {
  try {
    const j = JSON.parse(await readFile(join(root, "logs", "last-shutdown.json"), "utf8")) as { clean?: unknown; alive?: unknown };
    return { clean: j.clean === true, ...parseAlive(typeof j.alive === "string" ? j.alive : "") };
  } catch {
    return undefined;
  }
}

/** "HH:MM" in the computer's time. */
function hm(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/**
 * The short sentence for the page.
 *
 * @param run - The record of the previous run.
 * @returns "Last shutdown: not clean at HH:MM, free memory X GB" or "...clean", in both languages.
 */
export function shutdownLine(run: LastRun): HeavyLabel {
  if (run.clean) return { he: "הכיבוי האחרון: מסודר", en: "Last shutdown: clean" };
  const time = run.lastAlive ? hm(run.lastAlive) : "?";
  const gb = run.freeMb !== undefined ? (Math.round((run.freeMb / 1024) * 10) / 10).toString() : "?";
  return {
    he: `הכיבוי האחרון: לא מסודר בשעה ${time} — זיכרון פנוי ${gb} GB`,
    en: `Last shutdown: not clean at ${time}, free memory ${gb} GB`,
  };
}

/**
 * Turns Windows' event text into a plain meaning.
 *
 * @param id - 41, 1074 or 6008.
 * @param message - The event's message (for 1074 its reason is shown).
 */
export function powerMeaning(id: number, message: string): HeavyLabel {
  if (id === 41) return { he: "הפסקת חשמל או כיבוי לא מסודר (Kernel-Power 41)", en: "Power was lost or the computer did not shut down cleanly (Kernel-Power 41)" };
  if (id === 6008) return { he: "כיבוי בלתי צפוי (6008)", en: "Unexpected shutdown (6008)" };
  const reason = /(?:Reason|סיבה)\s*:\s*([^.]{3,80})/i.exec(message)?.[1]?.trim();
  return {
    he: `הופעל מחדש או כובה על ידי Windows או תוכנה${reason ? `: ${reason}` : ""} (1074)`,
    en: `Restarted or shut down by Windows or a program${reason ? `: ${reason}` : ""} (1074)`,
  };
}

/**
 * Parses the lines `ISO|id|message` the PowerShell read prints.
 *
 * @param out - The output.
 * @returns The events, in the order given.
 */
export function parsePowerEvents(out: string): PowerEvent[] {
  const events: PowerEvent[] = [];
  for (const line of out.split(/\r?\n/)) {
    const m = /^(\d{4}-\d\d-\d\dT[^|]+)\|(41|1074|6008)\|(.*)$/.exec(line.trim());
    if (m) events.push({ id: Number(m[2]), at: m[1]!, meaning: powerMeaning(Number(m[2]), m[3]!) });
  }
  return events.slice(0, 3);
}

let cached: { at: number; events: PowerEvent[] } | undefined;

/**
 * The newest Windows shutdown events (non-elevated read of the System log, 8 s limit, cached for 10 minutes).
 * Empty on other systems and on any failure.
 *
 * @returns Up to 3 events, newest first.
 */
export async function windowsPowerEvents(): Promise<PowerEvent[]> {
  if (process.platform !== "win32") return [];
  if (cached && Date.now() - cached.at < 600_000) return cached.events;
  const ps = "Get-WinEvent -FilterHashtable @{LogName='System';Id=41,1074,6008} -MaxEvents 3 -ErrorAction SilentlyContinue | ForEach-Object { '{0}|{1}|{2}' -f $_.TimeCreated.ToUniversalTime().ToString('o'), $_.Id, ($_.Message -replace '\\s+', ' ') }";
  const events = await new Promise<PowerEvent[]>((done) => {
    try {
      execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { windowsHide: true, timeout: 8000 }, (err, out) => done(err ? [] : parsePowerEvents(String(out ?? ""))));
    } catch {
      done([]);
    }
  });
  cached = { at: Date.now(), events };
  return events;
}

/**
 * Everything the page shows about the last shutdown.
 *
 * @param root - The data folder.
 */
export async function readShutdownInfo(root: string): Promise<ShutdownInfo> {
  const lastRun = await readLastRun(root);
  return { ...(lastRun ? { lastRun, line: shutdownLine(lastRun) } : {}), windows: await windowsPowerEvents() };
}

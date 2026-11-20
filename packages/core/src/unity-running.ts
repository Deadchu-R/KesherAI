import { execFile } from "node:child_process";
import { sameFolder } from "./unity-cli.js";

/** What the running Unity editors are: the projects named on their command lines, and whether one named none. */
export interface UnityProcesses {
  projects: string[];
  /** A Unity editor runs that did not say which project it has open (the project was picked inside Unity). */
  unnamed: boolean;
}

/**
 * Reads the Unity editors' command lines (one per process) for the projects they were started with.
 *
 * @param lines - Command lines of the running `Unity` / `Unity.exe` processes.
 * @returns The project folders named by `-projectPath`, and whether any process named none.
 */
export function parseUnityProcesses(lines: string[]): UnityProcesses {
  const projects: string[] = [];
  let unnamed = false;
  for (const line of lines) {
    const m = /-projectpath(?:\s+|=)(?:"([^"]+)"|(\S+))/i.exec(line);
    const path = m?.[1] ?? m?.[2];
    if (path) projects.push(path);
    else unnamed = true;
  }
  return { projects, unnamed };
}

/**
 * Whether a project's editor is open. A `Temp/UnityLockfile` alone is not enough: a crash leaves it behind, so a
 * running Unity process for the project is required (one that named no project may have it, so that still counts).
 *
 * @param project - The project folder.
 * @param lockfile - Whether `Temp/UnityLockfile` exists.
 * @param procs - The running editors, or undefined when the process list could not be read (then the lock file decides).
 */
export function editorOpen(project: string, lockfile: boolean, procs: UnityProcesses | undefined): boolean {
  if (!lockfile) return false;
  if (!procs) return true;
  return procs.unnamed || procs.projects.some((p) => sameFolder(p, project));
}

let cache: { at: number; value: Promise<UnityProcesses | undefined> } | undefined;

/**
 * The running Unity editors (Windows: PowerShell's process list; elsewhere: `ps`), read at most every 4 seconds.
 *
 * @returns The editors, or undefined when the list could not be read.
 */
export function runningUnity(): Promise<UnityProcesses | undefined> {
  if (cache && Date.now() - cache.at < 4_000) return cache.value;
  const win = process.platform === "win32";
  const value = new Promise<UnityProcesses | undefined>((done) => {
    const cb = (err: Error | null, out: string | Buffer) => {
      if (err) return done(undefined);
      const lines = String(out).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      done(parseUnityProcesses(win ? lines : lines.filter((l) => /(^|[\\/])Unity(\s|$)/.test(l) && !/Unity\s?Hub|UnityHelper|Unity\.Licensing/i.test(l))));
    };
    if (win) execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Get-CimInstance Win32_Process -Filter \"Name='Unity.exe'\" | ForEach-Object { $_.CommandLine }"], { windowsHide: true, timeout: 10_000 }, cb);
    else execFile("ps", ["-eo", "args="], { timeout: 10_000 }, cb);
  });
  cache = { at: Date.now(), value };
  return value;
}

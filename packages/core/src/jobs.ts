import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { mkdir, open, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Long jobs (a game build, packaging) that keep running when KesherAI
 * restarts for an update or is closed, and that KesherAI reattaches to
 * afterwards.
 *
 * How others do it: VS Code reconnects its terminals to the still-running
 * processes after a window reload (they live in a separate host process),
 * tmux-based setups keep processes outside the editor entirely, while
 * Claude Code's and Codex's in-progress tasks are killed on restart and only
 * the conversation resumes. KesherAI takes the first way for long jobs: the
 * job runs detached from KesherAI's process, its output goes to a file, and
 * a small record (command, folder, log, process id) lets a later KesherAI
 * find it, follow the log and read how it ended.
 *
 * A job ends with a marker line `__KESHER_EXIT__ <code>` that the wrapper
 * writes to the log, so the exit code is known even when KesherAI was not
 * running when the job finished. A computer that shuts down still stops the
 * job; then {@link JobStore.find} reports it as stopped and the tool runs
 * it again (build tools continue from what was already built).
 */

/** One job's record. */
export interface JobRecord {
  id: string;
  /** What it is, to find it again (e.g. "unreal-package:C:\\proj:android"). */
  key: string;
  file: string;
  args: string[];
  cwd?: string;
  log: string;
  pid?: number;
  startedAt: string;
}

/** A job's state now. */
export interface JobState extends JobRecord {
  state: "running" | "done" | "stopped";
  /** Exit code when done. */
  code?: number;
  /** The log so far. */
  output: string;
}

const EXIT = /__KESHER_EXIT__ (-?\d+)\s*$/m;

/** Whether a process id is alive (signal 0 checks without touching it). */
function alive(pid?: number): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The jobs kept in one folder (`~/.kesher/jobs`). */
export class JobStore {
  /** @param dir - The folder that keeps the job records and logs. */
  constructor(private readonly dir: string) {}

  private recordPath(id: string): string {
    return join(this.dir, `${id}.json`);
  }

  /**
   * Starts a job detached from KesherAI (it keeps running if KesherAI quits).
   * Windows .bat/.cmd files run through cmd.exe; every argument is quoted and
   * arguments with quotes or cmd's special characters are refused.
   */
  async start(key: string, file: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<JobRecord> {
    await mkdir(this.dir, { recursive: true });
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const log = join(this.dir, `${id}.log`);
    await writeFile(log, `> ${[file, ...args].join(" ")}\n`);
    const out = openSync(log, "a");
    let child;
    try {
      if (process.platform === "win32") {
        if ([file, ...args].some((a) => /["%^&|<>!\r\n]/.test(a))) throw new Error("A path or argument has a character Windows' command line cannot pass safely (\" % ^ & | < > !).");
        // "call": without it, cmd never comes back from a .bat to write the exit marker.
        const line = `${/\.(bat|cmd)$/i.test(file) ? "call " : ""}${[file, ...args].map((a) => `"${a}"`).join(" ")}`;
        // cmd runs the job, then writes the exit marker into the same log (/v:on: !ERRORLEVEL! is read after the job).
        child = spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/v:on", "/s", "/c", `"${line} & echo __KESHER_EXIT__ !ERRORLEVEL!"`], { cwd: opts.cwd, env: opts.env ?? process.env, detached: true, windowsHide: true, windowsVerbatimArguments: true, stdio: ["ignore", out, out] });
      } else {
        child = spawn("sh", ["-c", '"$0" "$@"; echo "__KESHER_EXIT__ $?"', file, ...args], { cwd: opts.cwd, env: opts.env ?? process.env, detached: true, stdio: ["ignore", out, out] });
      }
    } finally {
      closeSync(out);
    }
    child.unref();
    const rec: JobRecord = { id, key, file, args, cwd: opts.cwd, log, pid: child.pid, startedAt: new Date().toISOString() };
    await writeFile(this.recordPath(id), JSON.stringify(rec, null, 2));
    return rec;
  }

  /** A job's state, read from its log and process. */
  async state(rec: JobRecord): Promise<JobState> {
    const output = await readFile(rec.log, "utf8").catch(() => "");
    const m = EXIT.exec(output);
    if (m) return { ...rec, state: "done", code: Number(m[1]), output: output.replace(EXIT, "").trimEnd() };
    if (alive(rec.pid)) return { ...rec, state: "running", output };
    // It may have written the marker and exited between reading the log and checking the process: read again.
    const last = await readFile(rec.log, "utf8").catch(() => "");
    const m2 = EXIT.exec(last);
    if (m2) return { ...rec, state: "done", code: Number(m2[1]), output: last.replace(EXIT, "").trimEnd() };
    return { ...rec, state: "stopped", output: last };
  }

  /** The newest job with this key, if any. */
  async find(key: string): Promise<JobState | undefined> {
    return (await this.list()).find((j) => j.key === key);
  }

  /** Every job, newest first. */
  async list(): Promise<JobState[]> {
    const files = (await readdir(this.dir).catch(() => [] as string[])).filter((f) => f.endsWith(".json"));
    const recs: JobRecord[] = [];
    for (const f of files) {
      try {
        recs.push(JSON.parse(await readFile(join(this.dir, f), "utf8")) as JobRecord);
      } catch {
        // a broken record is skipped
      }
    }
    recs.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    return Promise.all(recs.map((r) => this.state(r)));
  }

  /** Jobs still running (an update should wait for them). */
  async running(): Promise<JobState[]> {
    return (await this.list()).filter((j) => j.state === "running");
  }

  /**
   * Waits until the job ends (or the signal aborts or time runs out), checking
   * every two seconds. If KesherAI quits meanwhile, the job goes on.
   */
  async wait(rec: JobRecord, opts: { timeoutMs: number; signal?: AbortSignal; onOutput?: (text: string) => void }): Promise<JobState> {
    const until = Date.now() + opts.timeoutMs;
    let shown = 0;
    for (;;) {
      // While it runs, only the new end of the log is read (a build's log grows to megabytes); the whole log once at the end.
      if (alive(rec.pid)) {
        const size = (await stat(rec.log).catch(() => ({ size: shown }))).size;
        if (opts.onOutput && size > shown) {
          const fh = await open(rec.log, "r").catch(() => undefined);
          if (fh) {
            const buf = Buffer.alloc(Math.min(size - shown, 256 * 1024));
            await fh.read(buf, 0, buf.length, Math.max(shown, size - buf.length)).catch(() => undefined);
            await fh.close();
            opts.onOutput(buf.toString("utf8"));
          }
          shown = size;
        }
        if (Date.now() > until || opts.signal?.aborted) return this.state(rec);
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }
      const s = await this.state(rec);
      if (opts.onOutput && Buffer.byteLength(s.output) > shown) opts.onOutput(Buffer.from(s.output).subarray(shown).toString("utf8"));
      if (s.state !== "running" || Date.now() > until || opts.signal?.aborted) return s;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  /** Stops a running job and its children. */
  stop(rec: JobRecord): void {
    if (!rec.pid) return;
    if (process.platform === "win32") spawn("taskkill", ["/pid", String(rec.pid), "/T", "/F"], { windowsHide: true });
    else {
      try {
        process.kill(-rec.pid, "SIGTERM");
      } catch {
        // already gone
      }
    }
  }

  /** Removes finished jobs older than a week. */
  async prune(maxAgeMs = 7 * 86_400_000): Promise<void> {
    for (const j of await this.list()) {
      if (j.state !== "running" && Date.now() - Date.parse(j.startedAt) > maxAgeMs) {
        await rm(this.recordPath(j.id), { force: true });
        await rm(j.log, { force: true });
      }
    }
  }
}

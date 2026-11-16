/**
 * The app's own short log (`logs/main.log` in the data folder): when it started, every way it ended (a quit and who
 * asked for it, an error nobody caught, a helper process or the page that crashed, the exit code). Kept on this
 * computer only, cut back when it passes 1 MB. Written synchronously so the last lines survive the process ending.
 */
import { promisify } from "node:util";
import cp, { execFile } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { freemem, totalmem } from "node:os";
import { dirname } from "node:path";
import { crashReporter, type App } from "electron";

/**
 * Starts the log and watches for the ways the app can end.
 *
 * @param app - Electron's app.
 * @param file - The log file.
 * @returns A function that writes one line.
 */
export function startMainLog(app: App, file: string): (line: string) => void {
  const write = (line: string) => {
    try {
      appendFileSync(file, `${new Date().toISOString()} ${line.replace(/\s+$/, "")}\n`);
    } catch {
      // A log that cannot be written never stops the app.
    }
  };
  try {
    mkdirSync(dirname(file), { recursive: true });
    if ((statSync(file, { throwIfNoEntry: false })?.size ?? 0) > 1024 * 1024) writeFileSync(file, "");
  } catch {
    // As above.
  }
  // The last run: when its last line is not "exit", it ended without Node knowing (a crash in native code, or ended
  // from outside): say so, so the next lines are read in that light.
  try {
    const last = readFileSync(file, "utf8").trimEnd().split("\n").at(-1) ?? "";
    if (last && !/ exit -?\d+$/.test(last)) write(`the previous run ended without an exit (crashed in native code or was ended from outside); its last line: ${last.slice(0, 200)}`);
  } catch {
    // no log yet
  }
  // The last moment the previous run was alive (kept every 2 s in a small file beside the log).
  const aliveFile = `${file}.alive`;
  try {
    const was = readFileSync(aliveFile, "utf8").trim();
    if (was) write(`the previous run was last alive at ${was}`);
  } catch {
    // first run
  }
  write(`start ${app.getVersion()} pid ${process.pid}`);
  const started = Date.now();
  setInterval(() => {
    try {
      const m = process.memoryUsage();
      const mb = (b: number) => Math.round(b / 1024 ** 2);
      writeFileSync(aliveFile, `${new Date().toISOString()} (pid ${process.pid}, ${Math.round((Date.now() - started) / 1000)} s after start; this app ${mb(m.rss)} MB, heap ${mb(m.heapUsed)}/${mb(m.heapTotal)} MB, external ${mb(m.external)} MB; computer free ${mb(freemem())} of ${mb(totalmem())} MB)`);
    } catch {
      // as above
    }
  }, 1000).unref();
  // Native crashes leave a minidump in the app's Crashpad folder (nothing is sent anywhere).
  try {
    crashReporter.start({ uploadToServer: false, compress: false });
    write(`crash dumps go to ${app.getPath("crashDumps")}`);
  } catch {
    // an older Electron
  }
  // What Windows recorded about this app's last crashes (Application log: 1000 application error, 1001 error
  // report, 1002 not responding), so a crash Node never saw still shows here.
  if (process.platform === "win32") {
    const ps = "Get-WinEvent -FilterHashtable @{LogName='Application'; Id=1000,1001,1002; StartTime=(Get-Date).AddHours(-24)} -MaxEvents 200 -ErrorAction SilentlyContinue | Where-Object { $_.Message -match 'KesherAI' } | Select-Object -First 4 | ForEach-Object { '{0:o} [{1}] {2}' -f $_.TimeCreated, $_.Id, ($_.Message -replace '\\s+', ' ') }";
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { windowsHide: true, timeout: 30_000 }, (_e, out) => {
      for (const line of String(out ?? "").split(/\r?\n/).filter(Boolean)) write(`windows log: ${line.slice(0, 700)}`);
    });
  }
  process.on("uncaughtException", (e) => write(`uncaught error: ${e?.stack ?? String(e)}`));
  process.on("unhandledRejection", (e) => write(`unhandled promise: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`.slice(0, 4000)));
  app.on("child-process-gone", (_e, d) => write(`helper process ended: ${d.type}${d.name ? ` (${d.name})` : ""} ${d.reason} exit ${d.exitCode}`));
  app.on("render-process-gone", (_e, _w, d) => write(`page process ended: ${d.reason} exit ${d.exitCode}`));
  app.on("before-quit", () => write(`quit asked by:${(new Error().stack ?? "").split("\n").slice(2, 8).join(" <")}`));
  process.on("exit", (code) => write(`exit ${code}`));
  return write;
}

/**
 * Writes down the programs this app starts (once per command every 10 minutes), so a run that is ended from outside
 * can be matched with a command that ended it (for example a `taskkill` or `Stop-Process`). Set before the core loads.
 *
 * @param write - The log's writer.
 */
export function watchChildren(write: (line: string) => void): void {
  const seen = new Map<string, number>();
  const note = (file: unknown, args: unknown) => {
    const line = `${String(file)} ${Array.isArray(args) ? args.map(String).join(" ") : ""}`.replace(/\s+/g, " ").slice(0, 300);
    const now = Date.now();
    if ((seen.get(line) ?? 0) > now - 10 * 60_000) return;
    seen.set(line, now);
    write(`child: ${line}`);
  };
  const wrap = <F extends (...a: never[]) => unknown>(f: F): F => {
    const w = ((...a: Parameters<F>) => {
      try {
        note(a[0], a[1]);
      } catch {
        // never in the way
      }
      return f(...a);
    }) as F;
    // execFile and exec have their own promisified form (resolving { stdout, stderr }); without it, every
    // promisify(execFile) in the app resolves with stdout alone, and code reading `.stdout` sees nothing.
    const custom = (f as unknown as Record<symbol, unknown>)[promisify.custom];
    if (custom) Object.defineProperty(w, promisify.custom, { value: custom });
    return w;
  };
  cp.spawn = wrap(cp.spawn);
  cp.execFile = wrap(cp.execFile);
  cp.exec = wrap(cp.exec);
  syncBuiltinESMExports();
}

/** A node of V8's sampling heap profile. */
interface HeapNode {
  callFrame: { functionName: string; url: string; lineNumber: number };
  selfSize: number;
  children: HeapNode[];
}

/**
 * Watches the app's memory with V8's sampling heap profiler (cheap: one sample per MB allocated). When the heap
 * passes 1.2 GB it writes the 15 call stacks holding the most memory to the log, so a runaway allocation shows its
 * source before the app runs out of memory.
 *
 * @param write - The log's writer.
 */
export async function watchHeap(write: (line: string) => void): Promise<void> {
  try {
    const { Session } = await import("node:inspector");
    const session = new Session();
    session.connect();
    const post = <T>(method: string, params?: object) => new Promise<T>((done, fail) => session.post(method, params ?? {}, (e, r) => (e ? fail(e) : done(r as T))));
    await post("HeapProfiler.startSampling", { samplingInterval: 1024 * 1024 });
    let told = false;
    const timer = setInterval(() => {
      if (told || process.memoryUsage().heapUsed < 1.2 * 1024 ** 3) return;
      told = true;
      clearInterval(timer);
      void post<{ profile: { head: HeapNode } }>("HeapProfiler.getSamplingProfile").then(
        ({ profile }) => {
          const stacks: Array<{ size: number; stack: string }> = [];
          const walk = (n: HeapNode, path: string[]) => {
            const here = n.callFrame.functionName || n.callFrame.url ? [...path, `${n.callFrame.functionName || "(anonymous)"} ${n.callFrame.url.split(/[\\/]/).slice(-2).join("/")}:${n.callFrame.lineNumber + 1}`] : path;
            if (n.selfSize > 0) stacks.push({ size: n.selfSize, stack: here.slice(-6).reverse().join(" < ") });
            for (const c of n.children) walk(c, here);
          };
          walk(profile.head, []);
          stacks.sort((a, b) => b.size - a.size);
          write(`heap passed 1.2 GB; where it went (sampled):`);
          for (const s of stacks.slice(0, 15)) write(`  ${Math.round(s.size / 1024 ** 2)} MB: ${s.stack.slice(0, 600)}`);
        },
        (e: Error) => write(`heap profile failed: ${e.message}`),
      );
    }, 1000);
    timer.unref();
  } catch (e) {
    write(`heap watch could not start: ${(e as Error).message}`);
  }
}

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { AgentTool } from "@kesher/agent";
import { androidTools } from "./unreal-tools.js";

/**
 * Runs a game on the user's Android phone over USB and reads why it closed.
 *
 * How others do it: Unreal's own "Launch on device" and Unity's "Build and
 * Run" both install with adb, start the app and stream logcat into the
 * editor; Android Studio filters logcat to the app's process. KesherAI does
 * the same in one tool: install (optional), clear the log, start the app,
 * wait, then keep only the lines of the app's own processes plus crash lines,
 * so the model sees the reason (an Unreal "Fatal error", a Java exception, a
 * native crash) and not the rest of the phone's log, which can hold other
 * apps' private data.
 *
 * The phone must have USB debugging on and the computer allowed: that is the
 * user's choice on the phone, never done by KesherAI.
 */

const PKG = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/;

function adbPath(sdk?: string): string {
  const exe = process.platform === "win32" ? "adb.exe" : "adb";
  if (sdk && existsSync(join(sdk, "platform-tools", exe)))
    return join(sdk, "platform-tools", exe);
  return exe;
}

function adb(
  bin: string,
  args: string[],
  timeoutMs = 60_000,
): Promise<{ code: number; out: string }> {
  return new Promise((res) =>
    execFile(
      bin,
      args,
      { windowsHide: true, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout, stderr) =>
        res({
          code: err
            ? typeof (err as NodeJS.ErrnoException).code === "number"
              ? Number((err as NodeJS.ErrnoException).code)
              : 1
            : 0,
          out: `${stdout ?? ""}${stderr ?? ""}`,
        }),
    ),
  );
}

/**
 * The lines of a logcat dump (threadtime format) that belong to the app:
 * its processes (found from ActivityManager's "Start proc <pid>:<package>"
 * lines and from lines naming the package) and crash reports.
 */
export function appLines(
  log: string,
  pkg: string,
  knownPids: Iterable<string> = [],
): string[] {
  const lines = log.split(/\r?\n/);
  const pids = new Set<string>(knownPids);
  const startRe = new RegExp(
    `Start proc (\\d+):${pkg.replace(/\./g, "\\.")}[/:\\s]`,
  );
  for (const l of lines) {
    const m = startRe.exec(l);
    if (m?.[1]) pids.add(m[1]);
  }
  const pidOf = (l: string) =>
    /^\d\d-\d\d \d\d:\d\d:\d\d\.\d+\s+(?:\S+\s+)?(\d+)\s+\d+\s/.exec(l)?.[1];
  const keep: string[] = [];
  let inCrash = false;
  for (const l of lines) {
    const pid = pidOf(l);
    // A native crash report (tombstone in the log) is written by the crash dumper's own process: keep it when it names the app.
    if (/ F DEBUG\s*:\s*\*\*\* \*\*\*/.test(l)) inCrash = false;
    if (
      / F DEBUG\s*:/.test(l) &&
      (l.includes(pkg) || [...pids].some((p) => l.includes(`pid: ${p},`)))
    )
      inCrash = true;
    if (
      (pid && pids.has(pid)) ||
      l.includes(pkg) ||
      (inCrash && / F DEBUG\s*:/.test(l))
    )
      keep.push(l);
  }
  return keep;
}

/** Picks the lines worth reading first: errors, Unreal fatals, crashes. */
export function crashSummary(lines: string[]): string[] {
  return lines.filter(
    (l) =>
      / [EF] /.test(l) ||
      /Fatal|Assertion failed|Error:|LowLevelFatalError|signal \d+|backtrace|Exception|Unable to|Failed to|could not be/i.test(
        l,
      ),
  );
}

/** The phone tools for a chat with a game project in use. */
export function androidPhoneTools(): AgentTool[] {
  return [
    {
      risk: "exec",
      spec: {
        name: "android_run_on_phone",
        description:
          "Run an app on the user's Android phone connected by USB and read its log: optionally installs an .apk, starts the app, waits, and returns whether it is still running plus only the app's own log lines and crash lines (Unreal 'Fatal error', Java exceptions, native crashes). Use it when a game built for Android closes or crashes on the phone. Needs USB debugging on (the user turns it on); if no phone is found, tell the user how and stop.",
        inputSchema: {
          type: "object",
          properties: {
            package: {
              type: "string",
              description:
                "The app's package name, e.g. com.kesherai.autoshooter.",
            },
            apk: {
              type: "string",
              description:
                "An .apk on this computer to install first (optional).",
            },
            seconds: {
              type: "number",
              description:
                "How long to let it run before reading the log (default 20, max 120).",
            },
          },
          required: ["package"],
        },
      },
      preview: async (input) =>
        `${typeof input.apk === "string" && input.apk ? `Install ${input.apk} on the phone, then s` : "S"}tart ${String(input.package)} on the phone and read its log`,
      run: async (input, ctx) => {
        const pkg = String(input.package ?? "").trim();
        if (!PKG.test(pkg))
          return {
            output: "Not a package name (like com.company.game).",
            isError: true,
          };
        const seconds = Math.min(Math.max(Number(input.seconds) || 20, 3), 120);
        const bin = adbPath((await androidTools()).sdk);
        const dev = await adb(bin, ["devices"], 20_000);
        if (dev.code !== 0 && !dev.out.includes("List of devices"))
          return {
            output: `adb did not run (${bin}): ${dev.out.slice(0, 400)}\nThe Android SDK's platform-tools are needed (Unity's Android module or Android Studio has them).`,
            isError: true,
          };
        const rows = dev.out
          .split(/\r?\n/)
          .slice(1)
          .map((l) => l.trim().split(/\s+/))
          .filter((r) => r.length >= 2 && r[0]);
        if (!rows.length)
          return {
            output:
              "No phone found. STOP and tell the user (they do this on the phone, not KesherAI): Settings → About phone → tap Build number 7 times; then Settings → System → Developer options → turn on USB debugging; connect the phone to this computer with a USB cable and tap Allow on the phone. Then try again.",
          };
        if (rows.some((r) => r[1] === "unauthorized"))
          return {
            output:
              "The phone is connected but has not allowed this computer yet. STOP and tell the user to unlock the phone and tap Allow on the USB debugging question (tick 'Always allow from this computer'). Then try again.",
          };
        const serial = rows.find((r) => r[1] === "device")?.[0];
        if (!serial)
          return {
            output: `The phone is not ready: ${rows.map((r) => r.join(" ")).join("; ")}`,
          };
        const a = (args: string[], t?: number) =>
          adb(bin, ["-s", serial, ...args], t);
        const out: string[] = [];
        if (typeof input.apk === "string" && input.apk.trim()) {
          const apk = input.apk.trim();
          if (!/\.apk$/i.test(apk) || !existsSync(apk))
            return { output: `No .apk at ${apk}.`, isError: true };
          ctx?.progress?.("Installing on the phone…\n");
          const inst = await a(["install", "-r", apk], 15 * 60_000);
          out.push(
            `Install: ${inst.out.trim().split(/\r?\n/).slice(-2).join(" ")}`,
          );
          if (!/Success/.test(inst.out))
            return { output: out.join("\n"), isError: true };
        }
        await a(["shell", "am", "force-stop", pkg]);
        await a(["logcat", "-c"]);
        ctx?.progress?.("Starting the app…\n");
        const start = await a([
          "shell",
          "monkey",
          "-p",
          pkg,
          "-c",
          "android.intent.category.LAUNCHER",
          "1",
        ]);
        if (/No activities found|monkey aborted/i.test(start.out))
          return {
            output: `${out.join("\n")}\nThe app ${pkg} is not installed on the phone (or has no launcher screen).`,
            isError: true,
          };
        const until = Date.now() + seconds * 1000;
        let died = false;
        const seen = new Set<string>();
        while (Date.now() < until) {
          if (ctx?.signal?.aborted) break;
          await new Promise((r) => setTimeout(r, 1000));
          const pid = (await a(["shell", "pidof", pkg], 10_000)).out.trim();
          for (const p of pid.split(/\s+/)) if (/^\d+$/.test(p)) seen.add(p);
          if (!pid) {
            died = true;
            await new Promise((r) => setTimeout(r, 1500)); // let the crash report reach the log
            break;
          }
        }
        const log = await a(["logcat", "-d", "-v", "threadtime"], 60_000);
        const mine = appLines(log.out, pkg, seen);
        const key = crashSummary(mine);
        out.push(
          died
            ? `The app CLOSED by itself within ${seconds} seconds.`
            : `The app was still running after ${seconds} seconds.`,
        );
        out.push(
          `Important lines (${key.length}):\n${key.slice(-80).join("\n") || "(none)"}`,
        );
        out.push(
          `Last app log lines:\n${mine.slice(-120).join("\n") || "(none)"}`,
        );
        return { output: out.join("\n\n").slice(-20_000) };
      },
    },
  ];
}

import { spawn } from "node:child_process";

/**
 * Runs a program in a folder and collects its output (last 20,000 characters).
 * `shell` is only for a command line the user typed on this computer (a
 * project's check, e.g. "pnpm test"); everything else passes arguments as a list.
 *
 * @param cwd - The folder.
 * @param command - The program, or the whole command line when `shell`.
 * @param args - Arguments (no shell).
 * @param shell - Run through the system shell.
 * @param timeoutMs - Killed after this (default 20 minutes).
 */
export function runIn(cwd: string, command: string, args: string[], shell: boolean, timeoutMs = 20 * 60_000): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    let out = "";
    const add = (b: Buffer) => {
      out = (out + b.toString("utf8")).slice(-20_000);
    };
    const child = spawn(command, args, { cwd, shell, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout?.on("data", add);
    child.stderr?.on("data", add);
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: -1, out: e.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, out });
    });
  });
}

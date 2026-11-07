import { spawn } from "node:child_process";

/** Character budget for tool output the model sees. */
export const MAX_OUTPUT = 30_000;

/** Result of {@link runShell}. */
export interface ShellResult {
  output: string;
  /** Exit code, or `null` if it did not start or was stopped. */
  code: number | null;
  /** One line: exit code, timeout or start failure. */
  status: string;
}

/**
 * Runs a shell command (cmd on Windows, sh elsewhere), collecting its output.
 * Stopped on timeout or when `signal` aborts, with its child processes.
 *
 * @param command - Command line.
 * @param cwd - Working folder.
 * @param timeoutMs - Time limit.
 * @param signal - Abort to stop it.
 * @returns Output and exit code.
 */
export function runShell(command: string, cwd: string, timeoutMs: number, signal: AbortSignal): Promise<ShellResult> {
  return new Promise<ShellResult>((resolvePromise) => {
    const child = spawn(command, { cwd, shell: true, windowsHide: true, env: { ...process.env, CI: "1", FORCE_COLOR: "0" } });
    let out = "";
    const onData = (b: Buffer) => {
      out += b.toString();
      if (out.length > MAX_OUTPUT * 4) out = out.slice(-MAX_OUTPUT * 2);
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    let timedOut = false;
    const kill = () => {
      if (process.platform === "win32" && child.pid) spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
      else child.kill("SIGKILL");
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    const onAbort = () => kill();
    signal.addEventListener("abort", onAbort, { once: true });
    const finish = (code: number | null, error?: Error) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      const status = error
        ? `Could not start: ${error.message}`
        : timedOut
          ? `Stopped after ${timeoutMs / 1000} s (timeout).`
          : `Exit code ${code ?? "unknown"}.`;
      resolvePromise({ output: out, code: error || timedOut ? null : code, status });
    };
    child.on("error", (err) => finish(null, err));
    child.on("close", (code) => finish(code));
  });
}


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
 * @param onOutput - Gets the output as it comes (for a live view).
 * @returns Output and exit code.
 */
export function runShell(command: string, cwd: string, timeoutMs: number, signal: AbortSignal, onOutput?: (text: string) => void): Promise<ShellResult> {
  return new Promise<ShellResult>((resolvePromise) => {
    const child = spawn(command, { cwd, shell: true, windowsHide: true, env: { ...process.env, CI: "1", FORCE_COLOR: "0" } });
    let out = "";
    const onData = (b: Buffer) => {
      const text = b.toString();
      out += text;
      onOutput?.(text);
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
    let done = false;
    const finish = (code: number | null, error?: Error) => {
      if (done) return;
      done = true;
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
    // A program started in the background (Windows "start", or "app &") keeps the output pipes open after the
    // shell itself has exited, so "close" only comes when that program quits (a game started this way held the
    // chat until it was closed). The shell's own exit is the end: wait a moment for the last output, then stop reading.
    child.on("exit", (code) => {
      setTimeout(() => {
        if (done) return;
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish(code);
      }, 1500);
    });
  });
}


/**
 * Reloads PATH from the system after something was installed, so new
 * programs (Python, Java, …) are found without restarting KesherAI. On
 * Windows it reads the machine and user PATH from the registry; elsewhere
 * it adds the usual install folders.
 */
export async function refreshPath(): Promise<void> {
  const current = process.env.PATH ?? process.env.Path ?? "";
  let fresh: string[] = [];
  if (process.platform === "win32") {
    const r = await runShell(
      `powershell -NoProfile -Command "[Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')"`,
      process.cwd(),
      15_000,
      new AbortController().signal,
    );
    if (r.code === 0) fresh = r.output.trim().split(";");
  } else {
    fresh = ["/opt/homebrew/bin", "/usr/local/bin", `${process.env.HOME ?? ""}/.local/bin`, `${process.env.HOME ?? ""}/.cargo/bin`];
  }
  const sepChar = process.platform === "win32" ? ";" : ":";
  const parts = [...new Set([...current.split(sepChar), ...fresh].map((p) => p.trim()).filter(Boolean))];
  const joined = parts.join(sepChar);
  process.env.PATH = joined;
  if (process.platform === "win32") process.env.Path = joined;
}

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
 * The agent's own name in git: its commits never carry the user's name or email from the computer's git settings
 * (Roee: nothing in git may show who he is). `.invalid` is a reserved domain, so the address reaches no one and
 * belongs to no GitHub account.
 */
export const AGENT_GIT_IDENTITY = {
  GIT_AUTHOR_NAME: "KesherAI",
  GIT_AUTHOR_EMAIL: "kesherai@noreply.invalid",
  GIT_COMMITTER_NAME: "KesherAI",
  GIT_COMMITTER_EMAIL: "kesherai@noreply.invalid",
} as const;

/**
 * A project inside WSL, opened through Windows' path to it (\\wsl.localhost\Ubuntu\home\me\game or \\wsl$\…): the
 * distribution and the Linux folder, so commands run in Linux (wsl.exe), not in cmd.exe on a network path.
 *
 * @param cwd - The project folder as Windows sees it.
 * @returns The distribution and the folder inside it, or undefined for a normal folder.
 */
export function wslTarget(cwd: string): { distro: string; dir: string } | undefined {
  const m = /^\\\\(?:wsl\.localhost|wsl\$)\\([^\\]+)(\\.*)?$/i.exec(cwd);
  if (!m) return undefined;
  return { distro: m[1]!, dir: (m[2] ?? "\\").replace(/\\/g, "/") || "/" };
}

/**
 * A project on another computer, opened through SSHFS-Win's path to it (\\sshfs.kr\user@host!22\home\me\game; the
 * `.r` forms are from the root, the others from the user's home): commands run there over Windows' own `ssh`.
 *
 * @returns The login, host, port and the folder there (absolute, or relative to home), or undefined.
 */
export function sshTarget(cwd: string): { user: string; host: string; port: number; dir: string; fromRoot: boolean } | undefined {
  const m = /^\\\\sshfs(\.k?r?)?\\([\w.-]{1,64})@([\w.-]{1,253})(?:!(\d{1,5}))?(\\.*)?$/i.exec(cwd);
  if (!m) return undefined;
  const fromRoot = /r/i.test(m[1] ?? "");
  const rest = (m[5] ?? "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  return { user: m[2]!, host: m[3]!, port: Number(m[4] ?? 22), dir: fromRoot ? `/${rest}` : rest, fromRoot };
}

/** A string as one POSIX shell word. */
export function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** The `ssh` arguments that run a command in a project's folder on another computer (never asks for a password). */
export function sshArgs(t: NonNullable<ReturnType<typeof sshTarget>>, command: string): string[] {
  const cd = t.fromRoot ? shQuote(t.dir || "/") : t.dir ? `"$HOME"/${shQuote(t.dir)}` : `"$HOME"`;
  return ["-o", "BatchMode=yes", "-o", "ConnectTimeout=15", "-p", String(t.port), `${t.user}@${t.host}`, `cd ${cd} && exec bash -lc ${shQuote(command)}`];
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
 * @param extraEnv - More variables (the project's environment).
 * @returns Output and exit code.
 */
export function runShell(command: string, cwd: string, timeoutMs: number, signal: AbortSignal, onOutput?: (text: string) => void, extraEnv: Record<string, string> = {}): Promise<ShellResult> {
  return new Promise<ShellResult>((resolvePromise) => {
    const env = { ...process.env, ...extraEnv, CI: "1", FORCE_COLOR: "0", ...AGENT_GIT_IDENTITY };
    // A WSL project: the command runs in its Linux distribution, in the project's folder (a login shell, so its PATH).
    const wsl = process.platform === "win32" ? wslTarget(cwd) : undefined;
    // A project on another computer (SSHFS-Win's path): the command runs there over ssh, in the project's folder.
    const ssh = wsl ? undefined : sshTarget(cwd);
    const child = wsl
      ? spawn("wsl.exe", ["-d", wsl.distro, "--cd", wsl.dir, "--", "bash", "-lc", command], { windowsHide: true, env })
      : ssh
        ? spawn("ssh", sshArgs(ssh, command), { windowsHide: true, env })
        : spawn(command, { cwd, shell: true, windowsHide: true, env });
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

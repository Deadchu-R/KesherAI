import { execFile, spawn } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { UIA_SCRIPT, releaseScript } from "./uia-script.js";

/**
 * The Windows UI Automation worker (docs/research/browser-computer-control.md, Phase 5; decision §5b.3): one
 * persistent PowerShell process, started on the first call and stopped after 5 idle minutes, on Stop and when
 * KesherAI exits. It reads apps' controls by name (buttons, fields, menus) and acts on them without moving the mouse.
 *
 * - Never elevated: the worker reports whether it runs as administrator in its first line, and an elevated worker is
 *   killed before it gets a single request.
 * - A call that does not answer in time kills the worker (an app can hang UI Automation); the next call starts a
 *   fresh one.
 * - Keys or the mouse button held when the worker is killed are let go by a one-shot script, so nothing stays stuck.
 */

/** A key for `holdKey`: Windows virtual-key code, and whether it is an extended key (arrows, Delete, Home...). */
export interface VkKey {
  vk: number;
  ext?: boolean;
}

/** One running worker process, as the client sees it (tests pass a fake). */
export interface UiaTransport {
  /** Sends one line (a JSON request) to the worker. */
  write(line: string): void;
  /** Called for every line the worker writes. */
  onLine(fn: (line: string) => void): void;
  /** Called once when the worker ends, with what it wrote to stderr last. */
  onExit(fn: (code: number | null, stderr: string) => void): void;
  /** Ends the worker now. */
  kill(): void;
}

/** What ComputerControl needs from the worker (tests pass a fake). */
export interface UiaClient {
  /**
   * Runs one operation.
   *
   * @param op - The worker's op (`tree`, `act`, `windows`...).
   * @param args - Its arguments.
   * @param opts.timeoutMs - How long to wait for the answer.
   * @param opts.signal - Abort (the chat's Stop): kills the worker.
   * @returns The op's result.
   */
  call<T = unknown>(op: string, args?: Record<string, unknown>, opts?: { timeoutMs?: number; signal?: AbortSignal }): Promise<T>;
  /** Ends the worker (Stop, exit) and fails every waiting call. */
  kill(reason?: string): void;
  /** @returns Whether a worker process is running now. */
  running(): boolean;
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  op: string;
  args: Record<string, unknown>;
}

/** Workers alive in this process, killed when it exits. */
const live = new Set<UiaWorker>();
let exitHooked = false;

/** The client side of the worker: starts it on demand, matches answers to requests, times out and kills. */
export class UiaWorker implements UiaClient {
  private t: UiaTransport | undefined;
  private ready: Promise<UiaTransport> | undefined;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private idle: ReturnType<typeof setTimeout> | undefined;
  /** Whether the left button is down (a mouse down without its up yet), to let go of it after a kill. */
  private mouseDown = false;
  private readonly startTimeoutMs: number;
  private readonly callTimeoutMs: number;
  private readonly idleMs: number;

  /**
   * @param spawnWorker - Starts a worker process (`powershellWorker` on Windows; tests pass a fake).
   * @param opts.release - Lets go of held keys and the mouse button after a kill (a one-shot script on Windows).
   * @param opts.startTimeoutMs - How long the worker may take to say hello (default 20 s: UI Automation loads slowly).
   * @param opts.callTimeoutMs - The default time limit of a call (default 15 s).
   * @param opts.idleMs - Idle time after which the worker is stopped (default 5 minutes).
   */
  constructor(
    private readonly spawnWorker: () => UiaTransport,
    private readonly opts: { release?: (keys: VkKey[], mouse: boolean) => void; startTimeoutMs?: number; callTimeoutMs?: number; idleMs?: number } = {},
  ) {
    this.startTimeoutMs = opts.startTimeoutMs ?? 20_000;
    this.callTimeoutMs = opts.callTimeoutMs ?? 15_000;
    this.idleMs = opts.idleMs ?? 5 * 60_000;
  }

  /** @returns Whether a worker process is running now. */
  running(): boolean {
    return !!this.t;
  }

  /** Starts the worker (once) and waits for its hello line. */
  private start(): Promise<UiaTransport> {
    if (this.ready) return this.ready;
    this.ready = new Promise<UiaTransport>((resolve, reject) => {
      let t: UiaTransport;
      try {
        t = this.spawnWorker();
      } catch (e) {
        reject(new Error(`Could not start the Windows UI Automation worker: ${(e as Error).message}`));
        return;
      }
      let hello = false;
      const timer = setTimeout(() => {
        if (hello) return;
        t.kill();
        reject(new Error("The Windows UI Automation worker did not start in time."));
      }, this.startTimeoutMs);
      t.onLine((line) => {
        let msg: { hello?: string; elevated?: boolean; id?: number; ok?: boolean; result?: unknown; error?: string };
        try {
          msg = JSON.parse(line.replace(/^\uFEFF/, "")) as typeof msg;
        } catch {
          return; // Not a protocol line (a PowerShell warning): ignored.
        }
        if (!hello) {
          if (msg.hello !== "kesher-uia") return;
          hello = true;
          clearTimeout(timer);
          if (msg.elevated) {
            t.kill();
            reject(new Error("The Windows UI Automation worker runs as administrator, which KesherAI never allows. Start KesherAI without \"Run as administrator\"."));
            return;
          }
          this.t = t;
          live.add(this);
          hookExit();
          resolve(t);
          return;
        }
        if (typeof msg.id !== "number") return;
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.ok) {
          if (p.op === "mouse") this.mouseDown = p.args.kind === "down" ? true : p.args.kind === "up" ? false : this.mouseDown;
          p.resolve(msg.result);
        } else p.reject(new Error(String(msg.error ?? "The UI Automation call failed.")));
        this.armIdle();
      });
      t.onExit((code, stderr) => {
        clearTimeout(timer);
        const why = `The Windows UI Automation worker ended${code === null ? "" : ` (code ${code})`}${stderr ? `: ${stderr.trim().slice(-300)}` : "."}`;
        if (!hello) reject(new Error(why));
        if (this.t === t) this.reset(why);
      });
    });
    // A failed start can be tried again on the next call.
    this.ready.catch(() => {
      this.ready = undefined;
    });
    return this.ready;
  }

  /** Forgets the process and fails every waiting call. */
  private reset(why: string): void {
    const held = [...this.pending.values()].filter((p) => p.op === "holdKey").flatMap((p) => (Array.isArray(p.args.keys) ? (p.args.keys as VkKey[]) : []));
    const mouse = this.mouseDown;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error(why));
    }
    this.pending.clear();
    this.t = undefined;
    this.ready = undefined;
    this.mouseDown = false;
    if (this.idle) clearTimeout(this.idle);
    this.idle = undefined;
    live.delete(this);
    if (held.length || mouse) this.opts.release?.(held, mouse);
  }

  private armIdle(): void {
    if (this.idle) clearTimeout(this.idle);
    this.idle = setTimeout(() => {
      if (!this.pending.size) this.kill("idle");
    }, this.idleMs);
    this.idle.unref?.();
  }

  /**
   * Runs one operation on the worker, starting it when needed.
   *
   * @param op - The op name.
   * @param args - Its arguments (JSON).
   * @param opts.timeoutMs - Time limit; when it passes the worker is killed (it may be stuck in a hung app).
   * @param opts.signal - Abort: kills the worker and fails the call.
   * @returns The op's result.
   */
  async call<T = unknown>(op: string, args: Record<string, unknown> = {}, opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<T> {
    if (opts.signal?.aborted) throw new Error("Stopped.");
    const t = await this.start();
    if (opts.signal?.aborted) throw new Error("Stopped.");
    const id = this.nextId++;
    const limit = opts.timeoutMs ?? this.callTimeoutMs;
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => this.kill("Stopped.");
      const timer = setTimeout(() => {
        this.kill(`Windows did not answer within ${Math.round(limit / 1000)} s (the app may be busy or hung). The UI Automation worker was restarted; try again or take a screenshot.`);
      }, limit);
      this.pending.set(id, {
        resolve: (v) => {
          opts.signal?.removeEventListener("abort", onAbort);
          resolve(v as T);
        },
        reject: (e) => {
          opts.signal?.removeEventListener("abort", onAbort);
          reject(e);
        },
        timer,
        op,
        args,
      });
      opts.signal?.addEventListener("abort", onAbort, { once: true });
      if (this.idle) clearTimeout(this.idle);
      t.write(`${JSON.stringify({ id, op, args })}\n`);
    });
  }

  /**
   * Ends the worker now: Stop, exit, idle, or a call that timed out. Waiting calls fail with the reason.
   *
   * @param reason - What the waiting calls are told.
   */
  kill(reason = "The Windows UI Automation worker was stopped."): void {
    const t = this.t;
    if (!t) return;
    this.reset(reason);
    try {
      t.kill();
    } catch {
      // Already gone.
    }
  }
}

function hookExit(): void {
  if (exitHooked) return;
  exitHooked = true;
  process.once("exit", () => {
    for (const w of live) w.kill("KesherAI is closing.");
  });
}

/**
 * Starts the real worker: Windows PowerShell 5.1 (part of Windows, nothing to install), single-threaded apartment for
 * the clipboard, no profile, hidden window, as the same (never elevated) user as KesherAI.
 *
 * @returns The transport of the new process.
 */
export function powershellWorker(): UiaTransport {
  const file = join(tmpdir(), `kesher-uia-${randomUUID()}.ps1`);
  writeFileSync(file, UIA_SCRIPT, { encoding: "utf8", mode: 0o600 });
  const child = spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass", "-File", file], {
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (d: Buffer) => {
    stderr = (stderr + d.toString()).slice(-2000);
  });
  const cleanup = () => rmSync(file, { force: true });
  const lines = createInterface({ input: child.stdout });
  child.stdin.on("error", () => undefined);
  return {
    write: (line) => void child.stdin.write(line),
    onLine: (fn) => void lines.on("line", (l) => {
      // PowerShell parsed the file before its first line ran: it is not needed any more.
      cleanup();
      fn(l);
    }),
    onExit: (fn) => {
      child.once("error", (e) => {
        cleanup();
        fn(null, e.message);
      });
      child.once("exit", (code) => {
        cleanup();
        fn(code, stderr);
      });
    },
    kill: () => {
      child.kill();
      cleanup();
    },
  };
}

/**
 * Lets go of keys and the left mouse button with a one-shot PowerShell (after a kill during a hold).
 *
 * @param keys - Held keys.
 * @param mouse - Whether the left button may be down.
 */
export function releaseHeld(keys: VkKey[], mouse: boolean): void {
  execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", releaseScript(keys, mouse)], { windowsHide: true, timeout: 15_000 }, () => undefined);
}

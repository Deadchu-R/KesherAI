/**
 * Background commands in the chat (like Claude Code's `run_in_background`): `run_command` with `background: true`
 * starts the process and returns at once with an id and the output file; the model reads the output with
 * `command_output` (tail or grep, never whole), stops it with `command_stop` and lists its commands with `commands`.
 * When one ends the chat gets a new turn ("[KesherAI] Background command finished: ...") through the same wake path as
 * check_back_later (a message into the chat, queued while it answers; the phone is told when that turn ends).
 *
 * Output goes to a file under background/, kept to the last ~5 MB (a ring: when it grows past the cap the older half
 * is dropped). Limits: 4 running per chat, 12 in all. Every process is killed with its children (taskkill /T on Windows)
 * when its chat is deleted or KesherAI quits; on the next start a command still marked running (a crash) is killed by
 * its pid and marked "ended with KesherAI".
 */
import type { AgentTool } from "@kesher/agent";
import { killTree, spawnShell } from "@kesher/agent";
import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** The output file keeps about this much (the last part). */
export const OUTPUT_CAP = 5 * 1024 * 1024;
/** At most this many running per chat. */
export const RUNNING_PER_CHAT = 4;
/** At most this many running in all chats. */
export const RUNNING_TOTAL = 12;
/** Finished commands kept per chat (older ones and their files are dropped). */
export const FINISHED_KEPT = 20;
/** The last lines given to the chat when a command ends. */
export const WAKE_TAIL_LINES = 30;
/** `command_output` gives at most this many lines. */
export const MAX_TAIL_LINES = 200;

/** One background command. */
export interface BackgroundCommand {
  id: string;
  convId: string;
  command: string;
  cwd: string;
  /** running; exited (on its own, see `exit`); stopped (by the model or the user); ended (KesherAI closed while it ran). */
  state: "running" | "exited" | "stopped" | "ended";
  /** Exit code (an `exited` command; null when it was killed by a signal). */
  exit?: number | null;
  startedAt: number;
  endedAt?: number;
  /** The output file. */
  file: string;
  pid?: number;
}

/** What the manager needs from the app (and tests replace). */
export interface BackgroundDeps {
  /** Where the log files and the list live. */
  dir: string;
  /** Sends a message into a chat (waits in its queue while it answers). */
  send(convId: string, text: string): Promise<unknown>;
  /** Called before a wake message: the phone is told when its turn ends (as for check_back_later). */
  onWake?(convId: string): void;
  /** Starts the process (default: the chat's shell, spawnShell). */
  spawn?(command: string, cwd: string, env: Record<string, string>): ChildProcess;
  /** Kills a process and its children (default: killTree). */
  kill?(pid: number | undefined, child?: ChildProcess): void;
  /** The clock (tests). */
  now?(): number;
}

/** @returns "2m 14s", "45s" or "1h 05m" for a length in milliseconds. */
export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
}

/** The last `n` lines of `text` (those that contain `grep`, case-insensitive and literal, when given). */
export function tailLines(text: string, n: number, grep?: string): string[] {
  let lines = text.replace(/\r\n?/g, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  const g = grep?.trim().toLowerCase();
  if (g) lines = lines.filter((l) => l.toLowerCase().includes(g));
  return lines.slice(-Math.max(1, Math.min(MAX_TAIL_LINES, Math.floor(n) || WAKE_TAIL_LINES))).map((l) => (l.length > 500 ? `${l.slice(0, 500)}…` : l));
}

/** Owns the background commands of all chats. */
export class BackgroundCommands {
  private list_: BackgroundCommand[] = [];
  private readonly live = new Map<string, { child: ChildProcess; written: number; queue: Promise<void> }>();
  private loaded?: Promise<void>;
  private saving: Promise<void> = Promise.resolve();
  private readonly now: () => number;

  /** @param deps - Where it lives and how it reaches the chat. */
  constructor(private readonly deps: BackgroundDeps) {
    this.now = deps.now ?? Date.now;
  }

  private get file(): string {
    return join(this.deps.dir, "commands.json");
  }

  /**
   * Reads the saved list: a command still marked running was running when KesherAI went down. Its process is killed
   * by pid (it may have outlived us) and it is marked "ended with KesherAI".
   */
  start(): Promise<void> {
    this.loaded ??= (async () => {
      await mkdir(this.deps.dir, { recursive: true }).catch(() => undefined);
      try {
        this.list_ = (JSON.parse(await readFile(this.file, "utf8")) as BackgroundCommand[]).filter((c) => c && typeof c.id === "string" && typeof c.convId === "string");
      } catch {
        this.list_ = [];
      }
      for (const c of this.list_) {
        if (c.state !== "running") continue;
        if (c.pid) (this.deps.kill ?? killTree)(c.pid);
        c.state = "ended";
        c.endedAt = this.now();
      }
      await this.save();
    })();
    return this.loaded;
  }

  /** Kills every running command (KesherAI is closing); they are marked "ended". */
  async stopAll(): Promise<void> {
    for (const c of this.list_.filter((x) => x.state === "running")) this.kill(c, "ended");
    await this.save();
  }

  /** @returns A chat's commands (or all), newest first. */
  list(convId?: string): BackgroundCommand[] {
    return this.list_.filter((c) => !convId || c.convId === convId).sort((a, b) => b.startedAt - a.startedAt);
  }

  /**
   * Starts a command in the background.
   *
   * @param convId - The chat.
   * @param command - The command line (already approved by the chat's mode and the command guard).
   * @param cwd - The working folder.
   * @param env - The project's environment.
   * @returns The command, or throws a message for the model when a limit is reached.
   */
  async run(convId: string, command: string, cwd: string, env: Record<string, string> = {}): Promise<BackgroundCommand> {
    await this.start();
    const running = this.list_.filter((c) => c.state === "running");
    if (running.filter((c) => c.convId === convId).length >= RUNNING_PER_CHAT) throw new Error(`This chat already has ${RUNNING_PER_CHAT} background commands running. Wait for one to end or stop one with command_stop.`);
    if (running.length >= RUNNING_TOTAL) throw new Error(`There are already ${RUNNING_TOTAL} background commands running in all chats. Wait for one to end first.`);
    const id = randomUUID().slice(0, 8);
    const c: BackgroundCommand = { id, convId, command, cwd, state: "running", startedAt: this.now(), file: join(this.deps.dir, `${id}.log`) };
    await writeFile(c.file, "", "utf8");
    const child = (this.deps.spawn ?? spawnShell)(command, cwd, env);
    if (child.pid) c.pid = child.pid;
    const live = { child, written: 0, queue: Promise.resolve() as Promise<void> } as { child: ChildProcess; written: number; queue: Promise<void> };
    this.live.set(id, live);
    this.list_.push(c);
    const onData = (b: Buffer | string) => {
      const buf = Buffer.from(b);
      live.queue = live.queue.then(() => this.append(c, live, buf)).catch(() => undefined);
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    let done = false;
    const finish = (code: number | null, error?: Error) => {
      if (done) return;
      done = true;
      if (error) onData(`Could not start: ${error.message}\n`);
      void this.finished(c, live, error ? 127 : code);
    };
    child.on("error", (e) => finish(null, e));
    child.on("close", (code) => finish(code));
    // A program the command started keeps the pipes open after the shell exits: the shell's own exit is the end.
    child.on("exit", (code) =>
      setTimeout(() => {
        if (done) return;
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish(code);
      }, 1500).unref?.(),
    );
    await this.save();
    return c;
  }

  /** Appends output; past the cap the older half is dropped. */
  private async append(c: BackgroundCommand, live: { written: number }, buf: Buffer): Promise<void> {
    await appendFile(c.file, buf);
    live.written += buf.length;
    if (live.written <= OUTPUT_CAP) return;
    const keep = (await readFile(c.file)).subarray(-Math.floor(OUTPUT_CAP / 2));
    await writeFile(c.file, keep);
    live.written = keep.length;
  }

  /** The process ended: record it, and unless the user or the app stopped it, wake the chat. */
  private async finished(c: BackgroundCommand, live: { queue: Promise<void> }, code: number | null): Promise<void> {
    await live.queue;
    this.live.delete(c.id);
    if (c.state !== "running") return;
    c.state = "exited";
    c.exit = code;
    c.endedAt = this.now();
    await this.save();
    const text = await this.tail(c, WAKE_TAIL_LINES).catch(() => "");
    try {
      this.deps.onWake?.(c.convId);
      await this.deps.send(c.convId, `[KesherAI] Background command finished: ${c.command.slice(0, 200)} (exit ${code ?? "?"}, ${duration(c.endedAt - c.startedAt)})\n\nLast ${WAKE_TAIL_LINES} lines (id ${c.id}, more with command_output):\n${text || "(no output)"}`);
    } catch {
      // the chat is gone or cannot take a message now
    }
    this.trim(c.convId);
  }

  /** Kills a running command's process tree and marks it. */
  private kill(c: BackgroundCommand, state: "stopped" | "ended"): void {
    const live = this.live.get(c.id);
    c.state = state;
    c.endedAt = this.now();
    (this.deps.kill ?? killTree)(c.pid, live?.child);
    this.live.delete(c.id);
  }

  /** Drops the oldest finished commands (and their files) beyond FINISHED_KEPT. */
  private trim(convId: string): void {
    const old = this.list_.filter((c) => c.convId === convId && c.state !== "running").sort((a, b) => b.startedAt - a.startedAt).slice(FINISHED_KEPT);
    for (const c of old) void rm(c.file, { force: true }).catch(() => undefined);
    if (old.length) this.list_ = this.list_.filter((c) => !old.includes(c));
  }

  /**
   * The last lines of a command's output.
   *
   * @param c - The command.
   * @param n - How many lines (at most 200).
   * @param grep - Only lines that contain this text (case-insensitive).
   */
  async tail(c: BackgroundCommand, n: number, grep?: string): Promise<string> {
    const text = await readFile(c.file, "utf8").catch(() => "");
    return tailLines(text, n, grep).join("\n");
  }

  /** Stops a command (user or model). @returns Whether it was running. */
  async stop(convId: string, id: string): Promise<boolean> {
    const c = this.list_.find((x) => x.id === id && x.convId === convId);
    if (!c || c.state !== "running") return false;
    this.kill(c, "stopped");
    await this.save();
    return true;
  }

  /** A chat was deleted: its processes are killed and its commands and files removed. */
  async forget(convId: string): Promise<void> {
    const mine = this.list_.filter((c) => c.convId === convId);
    if (!mine.length) return;
    for (const c of mine) {
      if (c.state === "running") this.kill(c, "stopped");
      void rm(c.file, { force: true }).catch(() => undefined);
    }
    this.list_ = this.list_.filter((c) => c.convId !== convId);
    await this.save();
  }

  private save(): Promise<void> {
    const data = JSON.stringify(this.list_, null, 1);
    this.saving = this.saving.then(() => writeFile(this.file, data, "utf8")).catch(() => undefined);
    return this.saving;
  }

  /**
   * `run_command` of a chat with `background: true` handled here (approvals, preview and the command guard stay the
   * original tool's).
   *
   * @param convId - The chat.
   * @param tool - The run_command tool (anything else is returned as it is).
   */
  wrap(convId: string, tool: AgentTool): AgentTool {
    if (tool.spec.name !== "run_command") return tool;
    return {
      ...tool,
      run: async (input, ctx) => {
        if (input.background !== true) return tool.run(input, ctx);
        if (!ctx.workspace) throw new Error("This conversation has no project folder. Start a code conversation to run commands.");
        const c = await this.run(convId, String(input.command ?? ""), ctx.workspace, ctx.env ?? {});
        return { output: `Started in the background (id ${c.id}). Output file: ${c.file}\nKeep working; the chat gets a new turn when it ends. Read the output with command_output (tail_lines, grep), stop it with command_stop.` };
      },
    };
  }

  /** `command_output`, `command_stop` and `commands` for one chat. */
  tools(convId: string): AgentTool[] {
    const find = (id: unknown) => {
      const c = this.list_.find((x) => x.id === String(id ?? "") && x.convId === convId);
      if (!c) throw new Error(`No background command "${String(id ?? "")}" in this chat. Use commands to list them.`);
      return c;
    };
    const state = (c: BackgroundCommand) => (c.state === "running" ? `running ${duration(this.now() - c.startedAt)}` : c.state === "exited" ? `exit ${c.exit ?? "?"}, ${duration((c.endedAt ?? c.startedAt) - c.startedAt)}` : c.state === "stopped" ? "stopped" : "ended with KesherAI");
    return [
      {
        risk: "read",
        spec: {
          name: "command_output",
          description: "Read the end of a background command's output (run_command with background:true) without dumping everything: the last tail_lines lines (default 30, max 200), or only the lines that contain grep.",
          inputSchema: {
            type: "object",
            properties: {
              id: { type: "string", description: "The command's id." },
              tail_lines: { type: "integer", description: "How many last lines (1 to 200, default 30)." },
              grep: { type: "string", description: "Only lines that contain this text (case-insensitive)." },
            },
            required: ["id"],
          },
        },
        run: async (input) => {
          const c = find(input.id);
          const out = await this.tail(c, Number(input.tail_lines ?? WAKE_TAIL_LINES), typeof input.grep === "string" ? input.grep : undefined);
          return { output: `${c.command.slice(0, 120)} (${state(c)})\n${out || "(no matching output)"}` };
        },
      },
      {
        risk: "read",
        spec: {
          name: "command_stop",
          description: "Stop a background command and its child processes.",
          inputSchema: { type: "object", properties: { id: { type: "string", description: "The command's id." } }, required: ["id"] },
        },
        run: async (input) => {
          const c = find(input.id);
          return { output: (await this.stop(convId, c.id)) ? `Stopped ${c.id}.` : `${c.id} is not running (${state(c)}).` };
        },
      },
      {
        risk: "read",
        spec: { name: "commands", description: "List this chat's background commands, running and finished, with their ids.", inputSchema: { type: "object", properties: {} } },
        run: async () => ({ output: this.list(convId).map((c) => `${c.id}  ${state(c)}  ${c.command.slice(0, 100)}`).join("\n") || "No background commands in this chat." }),
      },
    ];
  }
}

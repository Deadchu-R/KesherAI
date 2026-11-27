/**
 * Claude Code on this PC as a task-inbox executor (docs/RESEARCH_LOG.md 2026-11-24, "Claude Code as an executor"):
 * finds the user's own `claude` program, checks that it is signed in with the user's Claude subscription (never an API
 * key), and runs one task headless in a worktree: `claude -p --input-format stream-json --output-format stream-json
 * --verbose`, its stream parsed into KesherAI's step events.
 *
 * Safety: edits only inside the worktree (`--permission-mode acceptEdits`), shell commands only the inbox's allowed
 * check commands, no push, no web fetch, none of the user's own settings, hooks or MCP servers (`--setting-sources
 * project`, `--strict-mcp-config`); any other permission ask is refused by `-p` itself. API-key variables are removed
 * from the child's environment so a run can never bill pay-per-use. KesherAI never reads the login token.
 *
 * Quota: a status-line command (given through `--settings` for KesherAI's own runs only, never the user's global
 * settings) writes the subscription's `rate_limits` (5-hour and weekly percent and reset) to a file KesherAI reads;
 * the stream's own `rate_limit_event` updates the same file. Both are Claude Code's official outputs.
 */
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { delimiter, dirname, join, posix, win32 } from "node:path";
import { createInterface } from "node:readline";
import type { ClaudeQuota, ClaudeState, ClaudeWindow } from "@kesher/shared";
import type { AgentStep } from "./agent-watch.js";

/** How to start Claude Code: the program and the arguments that come before KesherAI's own. */
export interface ClaudeCli {
  program: string;
  pre: string[];
}

/**
 * Finds the `claude` program without a shell: the native installer's place first, then the PATH. On Windows an npm
 * install is a `claude.cmd` shim (which needs cmd.exe): its `cli.js` is run with Node instead.
 *
 * @param o.platform - The system (process.platform).
 * @param o.env - The environment (PATH, USERPROFILE).
 * @param o.home - The home folder.
 * @param o.exists - Whether a file exists (fake in tests).
 * @param o.node - The Node program for a `cli.js` (default this process; Electron runs as Node through the env).
 * @returns How to start it, or undefined when it is not installed.
 */
export function findClaude(o: { platform: NodeJS.Platform; env: NodeJS.ProcessEnv; home: string; exists: (p: string) => boolean; node?: string }): ClaudeCli | undefined {
  const win = o.platform === "win32";
  const path = win ? win32 : posix;
  const dirs = (o.env.PATH ?? o.env.Path ?? "").split(win ? ";" : delimiter).map((d) => d.trim().replace(/^"|"$/g, "")).filter(Boolean);
  if (win) {
    const exe = [path.join(o.env.USERPROFILE || o.home, ".local", "bin", "claude.exe"), ...dirs.map((d) => path.join(d, "claude.exe"))].find(o.exists);
    if (exe) return { program: exe, pre: [] };
    for (const d of dirs) {
      if (!o.exists(path.join(d, "claude.cmd"))) continue;
      const cli = path.join(d, "node_modules", "@anthropic-ai", "claude-code", "cli.js");
      if (o.exists(cli)) return { program: o.node ?? process.execPath, pre: [cli] };
    }
    return undefined;
  }
  // An app started from the desktop has a short PATH: the usual install places are looked at too.
  const found = [path.join(o.home, ".local", "bin", "claude"), ...dirs.map((d) => path.join(d, "claude")), "/opt/homebrew/bin/claude", "/usr/local/bin/claude"].find(o.exists);
  return found ? { program: found, pre: [] } : undefined;
}

/** Variables that would make Claude Code bill an API account or another cloud instead of the user's subscription. */
const PAID_ENV = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY", "CLAUDECODE"];

/**
 * The environment for a Claude Code run: this process's, without API keys or other billing routes, and with Electron
 * running as plain Node (for a `cli.js` and for the status-line script).
 *
 * @param base - The environment to start from.
 * @param electron - KesherAI runs inside Electron.
 */
export function claudeEnv(base: NodeJS.ProcessEnv, electron = !!process.versions.electron): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const k of PAID_ENV) delete env[k];
  if (electron) env.ELECTRON_RUN_AS_NODE = "1";
  return env;
}

/**
 * The status-line script KesherAI writes next to its data (fixed text, no input from a task). Claude Code runs it with
 * the session's JSON on stdin; it keeps only `rate_limits` (no prompt, no path) in the file named by its argument.
 */
export const STATUS_LINE_SCRIPT = `// KesherAI: the status line of KesherAI's own Claude Code runs. Keeps only the subscription's rate_limits.
const fs = require("fs");
const out = process.argv[2];
let body = "";
process.stdin.on("data", (d) => (body += d));
process.stdin.on("end", () => {
  try {
    const r = JSON.parse(body).rate_limits;
    const w = (x) => (x && typeof x.used_percentage === "number" && typeof x.resets_at === "number" ? { usedPercentage: x.used_percentage, resetsAt: x.resets_at * 1000 } : undefined);
    if (r && out) {
      fs.writeFileSync(out + ".tmp", JSON.stringify({ fiveHour: w(r.five_hour), sevenDay: w(r.seven_day), at: Date.now() }));
      fs.renameSync(out + ".tmp", out);
    }
  } catch {}
  process.stdout.write("KesherAI");
});
`;

/**
 * Writes the status-line script and the settings file for KesherAI's runs (only `statusLine`; given with
 * `--settings`, so the user's own settings are never touched).
 *
 * @param dir - KesherAI's folder for Claude Code (its data folder).
 * @param node - The Node program that runs the script.
 * @returns The settings file and the quota file the script writes.
 */
export async function writeClaudeSettings(dir: string, node = process.execPath): Promise<{ settings: string; quota: string }> {
  await mkdir(dir, { recursive: true });
  const script = join(dir, "statusline.cjs");
  const quota = join(dir, "quota.json");
  const settings = join(dir, "settings.json");
  await writeFile(script, STATUS_LINE_SCRIPT);
  // Forward slashes work for Node on Windows and need no escaping in either shell.
  const q = (p: string) => `"${p.replace(/\\/g, "/")}"`;
  await writeFile(settings, JSON.stringify({ statusLine: { type: "command", command: `${q(node)} ${q(script)} ${q(quota)}`, padding: 0 } }, null, 1));
  return { settings, quota };
}

/** Builtin tools a run never gets: the web (a task's text must not leave through it) and pushing. */
const DENIED = ["WebFetch", "WebSearch", "Bash(git push:*)", "Bash(git remote:*)", "Bash(curl:*)", "Bash(wget:*)"];

/**
 * Claude Code's arguments for one headless task (the prompt goes on stdin, as a stream-json user message).
 *
 * @param o.settings - The settings file from {@link writeClaudeSettings}.
 * @param o.commands - The inbox's allowed check commands (Settings › Task inbox); the only shell commands it may run.
 * @param o.model - The model alias or id (empty: Claude Code's default).
 */
export function claudeArgs(o: { settings: string; commands: readonly string[]; model?: string }): string[] {
  // Commands were checked when saved (no shell characters); each becomes a prefix rule, plus read-only git.
  const bash = [...o.commands.filter((c) => c.trim() && !/[\n;|&`$<>()]/.test(c)).map((c) => `Bash(${c.trim()}:*)`), "Bash(git status:*)", "Bash(git diff:*)", "Bash(git log:*)"];
  return [
    "-p",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose",
    "--permission-mode", "acceptEdits",
    "--setting-sources", "project",
    "--strict-mcp-config",
    "--settings", o.settings,
    "--allowedTools", ...bash,
    "--disallowedTools", ...DENIED,
    ...(o.model?.trim() ? ["--model", o.model.trim()] : []),
  ];
}

/** One thing a run's stream said, in KesherAI's terms. */
export type ClaudeEvent =
  | { kind: "init"; model?: string }
  | { kind: "step"; step: AgentStep }
  | { kind: "text"; text: string }
  | { kind: "limit"; window?: string; used?: number; resetsAt?: number; status?: string }
  | { kind: "result"; ok: boolean; text: string; subtype?: string };

/** An epoch in seconds or milliseconds, as milliseconds (undefined when it is not a number). */
const epochMs = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v > 0 ? (v < 1e12 ? v * 1000 : v) : undefined);

/**
 * Reads one line of Claude Code's stream-json output.
 *
 * @param line - One line (one JSON object); anything else is ignored.
 * @returns What it said (empty when nothing KesherAI uses).
 */
export function parseClaudeLine(line: string): ClaudeEvent[] {
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return [];
  }
  if (!j || typeof j !== "object") return [];
  if (j.type === "system" && j.subtype === "init") return [{ kind: "init", ...(typeof j.model === "string" ? { model: j.model } : {}) }];
  if (j.type === "assistant") {
    const content = (j.message as { content?: unknown } | undefined)?.content;
    const out: ClaudeEvent[] = [];
    for (const c of Array.isArray(content) ? (content as Array<Record<string, unknown>>) : []) {
      if (c.type === "tool_use" && typeof c.name === "string") out.push({ kind: "step", step: { tool: c.name, args: c.input } });
      else if (c.type === "text" && typeof c.text === "string" && c.text.trim()) out.push({ kind: "text", text: c.text });
    }
    return out;
  }
  if (j.type === "rate_limit_event") {
    const i = (j.rate_limit_info ?? {}) as Record<string, unknown>;
    const u = typeof i.utilization === "number" ? i.utilization : undefined;
    const at = epochMs(i.resetsAt ?? i.resets_at);
    // Subscription sessions also carry every window (`unifiedWindows`: five_hour, seven_day…), each with its
    // utilization: one event per window, so a single small answer refreshes both percents.
    const uw = i.unifiedWindows && typeof i.unifiedWindows === "object" ? (i.unifiedWindows as Record<string, unknown>) : undefined;
    if (uw) {
      const out: ClaudeEvent[] = [];
      for (const [window, v] of Object.entries(uw)) {
        if (window !== "five_hour" && window !== "seven_day") continue;
        const w = (v ?? {}) as Record<string, unknown>;
        const wu = typeof w.utilization === "number" ? w.utilization : undefined;
        const wat = epochMs(w.resetsAt ?? w.resets_at);
        if (wu === undefined || !wat) continue;
        out.push({ kind: "limit", window, used: wu <= 1 ? wu * 100 : wu, resetsAt: wat, ...(typeof i.status === "string" ? { status: i.status } : {}) });
      }
      if (out.length) return out;
    }
    // utilization is a fraction (0–1); a value above 1 is taken as a percent already.
    return [{ kind: "limit", ...(typeof (i.rateLimitType ?? i.rate_limit_type) === "string" ? { window: String(i.rateLimitType ?? i.rate_limit_type) } : {}), ...(u !== undefined ? { used: u <= 1 ? u * 100 : u } : {}), ...(at ? { resetsAt: at } : {}), ...(typeof i.status === "string" ? { status: i.status } : {}) }];
  }
  if (j.type === "result") {
    const text = typeof j.result === "string" ? j.result : "";
    return [{ kind: "result", ok: j.is_error !== true && (j.subtype === undefined || j.subtype === "success"), text, ...(typeof j.subtype === "string" ? { subtype: j.subtype } : {}) }];
  }
  return [];
}

/** Claude Code's own words when the subscription's limit is reached. */
const LIMIT_TEXT = /usage limit reached|you['’]ve (hit|reached) your (usage |session |weekly )?limit|(5-hour|five-hour|weekly|session) limit (reached|hit)|limit will reset|limit resets/i;

/**
 * Whether a message is Claude Code's "usage limit reached", and when it resets when it says so (the older
 * `…|<epoch seconds>` form). A time of day without a date is not guessed: the caller uses the quota file's reset.
 *
 * @param text - The message (a result, an error, stderr).
 * @returns `{ until }` (undefined when it did not say), or undefined when it is not a limit message.
 */
export function usageLimitOf(text: string): { until?: number } | undefined {
  if (!LIMIT_TEXT.test(text)) return undefined;
  const at = epochMs(Number(/\|(\d{10,13})\b/.exec(text)?.[1]));
  return at ? { until: at } : {};
}

/**
 * Reads the last quota reading.
 *
 * @param file - The quota file.
 * @returns The reading, or undefined when there is none (or it is unreadable).
 */
export async function readClaudeQuota(file: string): Promise<ClaudeQuota | undefined> {
  try {
    const j = JSON.parse(await readFile(file, "utf8")) as Partial<ClaudeQuota>;
    const w = (x: unknown): ClaudeWindow | undefined => {
      const v = x as Partial<ClaudeWindow> | undefined;
      return v && typeof v.usedPercentage === "number" && typeof v.resetsAt === "number" ? { usedPercentage: Math.max(0, Math.min(100, v.usedPercentage)), resetsAt: v.resetsAt } : undefined;
    };
    if (typeof j.at !== "number") return undefined;
    const fiveHour = w(j.fiveHour);
    const sevenDay = w(j.sevenDay);
    return { ...(fiveHour ? { fiveHour } : {}), ...(sevenDay ? { sevenDay } : {}), at: j.at };
  } catch {
    return undefined;
  }
}

/**
 * Puts one `rate_limit_event` into the quota file (the window it names; other windows are kept).
 *
 * @param file - The quota file.
 * @param ev - The event.
 * @param now - The clock.
 * @returns The new reading (unchanged when the event named no known window with a percent and a reset).
 */
export function mergeClaudeLimit(file: string, ev: Extract<ClaudeEvent, { kind: "limit" }>, now: number): Promise<ClaudeQuota | undefined> {
  // One write at a time per file: one stream line now gives two windows, and two read-modify-writes at once would
  // lose one window and race on the same temporary file.
  const run = (merging.get(file) ?? Promise.resolve()).catch(() => undefined).then(() => mergeOne(file, ev, now));
  merging.set(file, run);
  void run.finally(() => merging.get(file) === run && merging.delete(file)).catch(() => undefined);
  return run;
}

/** The quota file merges still running, per file (see {@link mergeClaudeLimit}). */
const merging = new Map<string, Promise<unknown>>();

/** One merge (see {@link mergeClaudeLimit}). */
async function mergeOne(file: string, ev: Extract<ClaudeEvent, { kind: "limit" }>, now: number): Promise<ClaudeQuota | undefined> {
  const q = (await readClaudeQuota(file)) ?? { at: now };
  const key = ev.window === "five_hour" ? "fiveHour" : ev.window === "seven_day" || ev.window === "seven_day_opus" ? "sevenDay" : undefined;
  if (!key || !ev.resetsAt) return q.fiveHour || q.sevenDay ? q : undefined;
  // A rejected window without a percent is full.
  const used = ev.used ?? (ev.status === "rejected" ? 100 : q[key]?.usedPercentage);
  if (used === undefined) return q.fiveHour || q.sevenDay ? q : undefined;
  const next: ClaudeQuota = { ...q, [key]: { usedPercentage: used, resetsAt: ev.resetsAt }, at: now };
  await mkdir(dirname(file), { recursive: true });
  await writeFile(`${file}.tmp`, JSON.stringify(next));
  await rename(`${file}.tmp`, file);
  return next;
}

/** Starts a program (injected in tests). */
export type SpawnFn = (program: string, args: string[], o: { cwd: string; env: NodeJS.ProcessEnv }) => ChildProcess;

const realSpawn: SpawnFn = (program, args, o) => spawn(program, args, { cwd: o.cwd, env: o.env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });

/** Ends a run and everything it started (on Windows the whole process tree). */
function kill(child: ChildProcess): void {
  if (child.exitCode !== null || child.killed) return;
  if (process.platform === "win32" && child.pid) spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true }).on("error", () => child.kill());
  else child.kill("SIGTERM");
}

/** How one run ended. */
export interface ClaudeRunEnd {
  code: number | null;
  /** The last `result` (undefined when it ended without one). */
  result?: { ok: boolean; text: string; subtype?: string };
  /** The subscription's limit stopped it (`until` when known). */
  limit?: { until?: number };
  /** The end of its error output, for the note. */
  stderr: string;
}

/**
 * Runs one Claude Code task: the prompt as the first stream-json user message, every stream line through
 * {@link parseClaudeLine} to `onEvent`. `attach` gets a function that sends one more user message (the rescue hint);
 * stdin closes when every message sent has its result, so the program ends by itself.
 *
 * @param o.cli - How to start it ({@link findClaude}).
 * @param o.cwd - The worktree.
 * @param o.args - {@link claudeArgs}.
 * @param o.prompt - The task's prompt.
 * @param o.env - {@link claudeEnv}.
 * @param o.signal - Stops the run (the process tree is ended).
 * @param o.onEvent - Each event, in order.
 * @param o.attach - Gets the "send one more message" function.
 * @param o.spawn - Starts the program (tests pass a fake CLI).
 * @returns How it ended (never throws for the run's own failure; a start failure rejects).
 */
export function runClaude(o: { cli: ClaudeCli; cwd: string; args: string[]; prompt: string; env: NodeJS.ProcessEnv; signal: AbortSignal; onEvent: (e: ClaudeEvent) => void; attach?: (send: (text: string) => Promise<void>) => void; spawn?: SpawnFn }): Promise<ClaudeRunEnd> {
  return new Promise((resolve, reject) => {
    const child = (o.spawn ?? realSpawn)(o.cli.program, [...o.cli.pre, ...o.args], { cwd: o.cwd, env: o.env });
    let pending = 0;
    let closed = false;
    let stderr = "";
    let result: ClaudeRunEnd["result"];
    let limit: ClaudeRunEnd["limit"];
    const message = (text: string) => `${JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] } })}\n`;
    const send = async (text: string) => {
      if (closed || !child.stdin?.writable) throw new Error("The Claude Code run has ended.");
      pending++;
      child.stdin.write(message(text));
    };
    const onAbort = () => kill(child);
    o.signal.addEventListener("abort", onAbort, { once: true });
    child.on("error", (e) => {
      o.signal.removeEventListener("abort", onAbort);
      reject(e);
    });
    child.stdin?.on("error", () => undefined);
    child.stderr?.on("data", (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-4000);
    });
    const lines = createInterface({ input: child.stdout! });
    lines.on("line", (line) => {
      for (const e of parseClaudeLine(line)) {
        if (e.kind === "limit" && e.status === "rejected") limit = { ...(e.resetsAt ? { until: e.resetsAt } : {}) };
        if (e.kind === "result") {
          result = { ok: e.ok, text: e.text, ...(e.subtype ? { subtype: e.subtype } : {}) };
          const l = !e.ok ? usageLimitOf(e.text) : undefined;
          if (l) limit = { ...limit, ...l };
          pending = Math.max(0, pending - 1);
          if (!pending && !closed) {
            closed = true;
            child.stdin?.end();
          }
        }
        o.onEvent(e);
      }
    });
    child.on("close", (code) => {
      o.signal.removeEventListener("abort", onAbort);
      closed = true;
      if (!limit && (!result || !result.ok)) {
        const l = usageLimitOf(stderr);
        if (l) limit = l;
      }
      resolve({ code, ...(result ? { result } : {}), ...(limit ? { limit } : {}), stderr: stderr.trim() });
    });
    void send(o.prompt);
    o.attach?.(send);
  });
}

/**
 * Checks the install and the login: `claude --version`, then `claude auth status --json` (Claude Code's own answer;
 * the token itself is never read). An API-key login counts as not allowed.
 *
 * @param run - Runs the program with these arguments and returns its output.
 * @returns The state's install and login part.
 */
export async function checkClaude(run: (args: string[]) => Promise<{ code: number; out: string }>): Promise<Pick<ClaudeState, "installed" | "version" | "loggedIn" | "account" | "plan">> {
  const v = await run(["--version"]).catch(() => ({ code: -1, out: "" }));
  const version = /\d+\.\d+\.\d+/.exec(v.out)?.[0];
  if (v.code !== 0 || !version) return { installed: false };
  const a = await run(["auth", "status", "--json"]).catch(() => ({ code: -1, out: "" }));
  try {
    const j = JSON.parse(a.out.slice(a.out.indexOf("{"))) as Record<string, unknown>;
    const method = String(j.authMethod ?? "");
    const account: ClaudeState["account"] = j.loggedIn !== true || method === "none" ? "none" : /api.?key/i.test(method) ? "api-key" : "subscription";
    const plan = typeof j.subscriptionType === "string" ? j.subscriptionType : undefined;
    return { installed: true, version, loggedIn: j.loggedIn === true, account, ...(plan ? { plan } : {}) };
  } catch {
    return { installed: true, version };
  }
}

/**
 * Runs the program once with these arguments (no shell), for {@link checkClaude}.
 *
 * @param cli - How to start it.
 * @param env - {@link claudeEnv}.
 * @param timeoutMs - Ends it after this long.
 */
export function claudeOnce(cli: ClaudeCli, env: NodeJS.ProcessEnv, timeoutMs = 20_000): (args: string[]) => Promise<{ code: number; out: string }> {
  return (args) =>
    new Promise((resolve) => {
      execFile(cli.program, [...cli.pre, ...args], { env, timeout: timeoutMs, windowsHide: true, maxBuffer: 1 << 20 }, (e, out, err) => {
        resolve({ code: e ? (typeof (e as { code?: unknown }).code === "number" ? ((e as { code: number }).code) : -1) : 0, out: `${out ?? ""}${err ?? ""}` });
      });
    });
}

/** Whether a path exists (the default for {@link findClaude}). */
export const fileExists = (p: string): boolean => existsSync(p);

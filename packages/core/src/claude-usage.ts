/**
 * Keeps the Claude plan's usage known on this PC (Roee, 27.11: "build something that lets you follow your usage"):
 * a tiny headless Claude Code answer, on the user's own subscription, whose stream carries the plan's windows
 * (`rate_limit_event` with `unifiedWindows`: five_hour and seven_day, each with its utilization and reset). The
 * reading goes into the same quota file the inbox's Claude runs write, so the task inbox, the hub and the lead
 * Claude chat (through /api/task-inbox or /api/claude/usage) all see one number.
 *
 * No unofficial usage endpoint and no reading of the login token: only Claude Code's own documented stream.
 * A check costs one very short answer on the smallest model; it runs only when Claude Code is installed and signed
 * in with a subscription (never an API key), at most every {@link MIN_GAP_MS}, and is skipped when a real run
 * refreshed the reading lately.
 */
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ClaudeQuota } from "@kesher/shared";
import { checkClaude, claudeEnv, claudeOnce, fileExists, findClaude, mergeClaudeLimit, readClaudeQuota, runClaude, writeClaudeSettings, type ClaudeCli, type ClaudeEvent } from "./claude-exec.js";

/** The shortest time between two checks (a click on "Check now" too). */
export const MIN_GAP_MS = 10 * 60_000;
/** How often the timer checks by itself. */
export const EVERY_MS = 30 * 60_000;

/** The probe's arguments: one short answer, the smallest model, no tools, no project settings. */
export function probeArgs(settings: string): string[] {
  return [
    "-p",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose",
    "--setting-sources", "project",
    "--strict-mcp-config",
    "--settings", settings,
    "--max-turns", "1",
    "--disallowedTools", "Bash", "Edit", "Write", "WebFetch", "WebSearch", "Task", "NotebookEdit",
    "--model", "haiku",
  ];
}

/** What a check found. */
export interface UsageCheck {
  ok: boolean;
  quota?: ClaudeQuota;
  /** Why it did not check (not installed, not signed in, too soon, the run failed). */
  why?: string;
}

/** What the watch needs (tests pass fakes). */
export interface UsageWatchDeps {
  /** KesherAI's data folder (the quota file is `<root>/claude-code/quota.json`, shared with the inbox's runs). */
  root: string;
  now?: () => number;
  /** Finds Claude Code (default: the real lookup). */
  cli?: () => ClaudeCli | undefined;
  /** Install and sign-in check (default: `claude --version` + `claude auth status`). */
  check?: (c: ClaudeCli) => Promise<{ installed: boolean; loggedIn?: boolean; account?: string }>;
  /** Runs one probe and gives its events (default: {@link runClaude}). */
  run?: (c: ClaudeCli, cwd: string, args: string[], onEvent: (e: ClaudeEvent) => void, signal: AbortSignal) => Promise<unknown>;
  log?: (line: string) => void;
}

/** Reads and refreshes the Claude plan's usage. */
export class ClaudeUsageWatch {
  private readonly dir: string;
  private readonly quotaFile: string;
  private last = 0;
  private running?: Promise<UsageCheck>;
  private timer?: NodeJS.Timeout;

  /**
   * @param d - The data folder and, in tests, fakes for finding, checking and running Claude Code.
   */
  constructor(private readonly d: UsageWatchDeps) {
    this.dir = join(d.root, "claude-code");
    this.quotaFile = join(this.dir, "quota.json");
  }

  private now(): number {
    return (this.d.now ?? Date.now)();
  }

  /** The last reading (from a check or from a real Claude run), without checking. */
  read(): Promise<ClaudeQuota | undefined> {
    return readClaudeQuota(this.quotaFile);
  }

  /**
   * Checks now, unless a reading is newer than {@link MIN_GAP_MS} (then that one is given back).
   *
   * @param force - Check even when the last reading is recent (still at most one check per {@link MIN_GAP_MS}).
   */
  check(force = false): Promise<UsageCheck> {
    this.running ??= this.doCheck(force).finally(() => (this.running = undefined));
    return this.running;
  }

  private async doCheck(force: boolean): Promise<UsageCheck> {
    const before = await this.read();
    const now = this.now();
    if (now - this.last < MIN_GAP_MS || (!force && before && now - before.at < MIN_GAP_MS)) return { ok: true, quota: before, why: "recent" };
    const c = (this.d.cli ?? (() => findClaude({ platform: process.platform, env: process.env, home: homedir(), exists: fileExists })))();
    if (!c) return { ok: false, quota: before, why: "Claude Code is not installed on this PC." };
    const st = await (this.d.check ?? ((x: ClaudeCli) => checkClaude(claudeOnce(x, claudeEnv(process.env)))))(c);
    if (!st.installed) return { ok: false, quota: before, why: "Claude Code is not installed on this PC." };
    if (!st.loggedIn) return { ok: false, quota: before, why: "Claude Code is not signed in." };
    if (st.account === "api-key") return { ok: false, quota: before, why: "Claude Code is signed in with an API key; only a subscription is checked." };
    this.last = now;
    await mkdir(this.dir, { recursive: true });
    const f = await writeClaudeSettings(this.dir);
    let quota = before;
    const merges: Promise<unknown>[] = [];
    const ctl = new AbortController();
    const stop = setTimeout(() => ctl.abort(), 90_000);
    try {
      await (this.d.run ?? ((cli, cwd, args, onEvent, signal) => runClaude({ cli, cwd, args, prompt: "Reply with the single word OK.", env: claudeEnv(process.env), signal, onEvent })))(c, this.dir, probeArgs(f.settings), (e) => {
        if (e.kind === "limit") merges.push(mergeClaudeLimit(f.quota, e, this.now()).then((q) => (quota = q ?? quota)));
      }, ctl.signal);
    } catch (e) {
      this.d.log?.(`claude usage: the check did not run (${(e as Error).message.slice(0, 120)})`);
      return { ok: false, quota, why: "The check did not run." };
    } finally {
      clearTimeout(stop);
    }
    await Promise.all(merges);
    const fresh = quota && quota.at >= now;
    return fresh ? { ok: true, quota } : { ok: false, quota, why: "Claude Code's answer had no usage windows." };
  }

  /** Checks every {@link EVERY_MS} (and once soon after start); a check that finds no Claude Code just waits. */
  start(): void {
    if (this.timer) return;
    const tick = () => void this.check().catch(() => undefined);
    this.timer = setInterval(tick, EVERY_MS);
    this.timer.unref?.();
    setTimeout(tick, 60_000).unref?.();
  }

  /** Stops the timer (KesherAI closing). */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}

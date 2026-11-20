import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { homedir, setPriority, userInfo } from "node:os";
import { join } from "node:path";
import { AGENT_GIT_IDENTITY } from "@kesher/agent";
import type { InboxBusy } from "@kesher/shared";
import { AcpAgent } from "../acp.js";
import { agyPath } from "../agy-path.js";
import type { KesherConfig } from "../config.js";
import type { GpuGuard } from "../gpu-guard.js";
import { busyPrograms, gameFoldersForBusy, inboxBusy, runningPrograms } from "../inbox-busy.js";
import { TaskInbox, type RunCmd } from "../inbox-runner.js";
import type { Notifier } from "../notify.js";
import { findGamesAndStoreApps } from "../pc-games.js";
import type { TaskBoard } from "../task-board.js";

/**
 * Runs a program with an argument list (never a shell, except on Windows for `.cmd` programs such as pnpm, where
 * the arguments were already checked to hold no shell syntax), at low priority, keeping up to 4 MB of output (a diff
 * or a task file must not be cut).
 */
function runner(lowPriority: boolean): RunCmd {
  return (cwd, args, timeoutMs = 10 * 60_000) =>
    new Promise((resolve) => {
      const [cmd, ...rest] = args;
      if (!cmd) return resolve({ code: -1, out: "No command." });
      const shell = process.platform === "win32" && cmd !== "git";
      if (shell && args.some((a) => /[&|<>^%"`;()]/.test(a))) return resolve({ code: -1, out: "Refused: shell characters." });
      let out = "";
      const child = spawn(cmd, rest, { cwd, shell, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...AGENT_GIT_IDENTITY } });
      if (lowPriority && child.pid) {
        try {
          setPriority(child.pid, 10);
        } catch {
          /* not allowed: runs at normal priority */
        }
      }
      const add = (b: Buffer) => {
        out += b.toString("utf8");
        if (out.length > 4_000_000) out = out.slice(-4_000_000);
      };
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

/**
 * Builds the task inbox: git and checks as argument lists, the unmodified `agy acp` (it signs in by itself), the
 * shared board, notifications to this PC and the phone, and the busy check (games, editors, the graphics card).
 *
 * @param p - The config, data folder, board, notifier and the graphics card guard.
 * @returns The inbox (fetching starts when it is on).
 */
export function buildTaskInbox(p: { config: KesherConfig; root: string; board: TaskBoard; notifier: Notifier; guard: GpuGuard }): TaskInbox {
  const git = runner(false);
  let games: { at: number; list: Array<{ name: string; folder: string }> } = { at: 0, list: [] };
  let programs: { at: number; list: Awaited<ReturnType<typeof runningPrograms>> } = { at: 0, list: [] };
  let gpuHighSince: number | undefined;
  const busy = async (): Promise<InboxBusy> => {
    const now = Date.now();
    const s = p.config.taskInbox;
    if (s.notWhileGame && now - games.at > 10 * 60_000) games = { at: now, list: gameFoldersForBusy(await findGamesAndStoreApps().catch(() => [])) };
    if ((s.notWhileGame || s.notWhileEditor) && now - programs.at > 30_000) programs = { at: now, list: await runningPrograms().catch(() => []) };
    const found = busyPrograms(programs.list, games.list);
    const cards = p.guard.status().cards;
    const gpu = cards.length ? Math.max(...cards.map((c) => c.util)) : undefined;
    if (gpu !== undefined && s.gpuBusyPercent > 0 && gpu >= s.gpuBusyPercent) gpuHighSince ??= now;
    else gpuHighSince = undefined;
    return { ...inboxBusy({ ...found, ...(gpu !== undefined ? { gpu } : {}), ...(gpuHighSince !== undefined ? { gpuHighSince } : {}), now }, s), games: games.list.length };
  };
  const inbox = new TaskInbox({
    settings: () => p.config.taskInbox,
    file: join(p.root, "task-inbox.json"),
    git,
    run: runner(true),
    // The unmodified Antigravity CLI in ACP mode, in the task's worktree only; no token or key passes through KesherAI.
    startAgent: async (cwd, h) => {
      const local = agyPath();
      const command = local && (await stat(local).catch(() => undefined)) ? local : "agy";
      return AcpAgent.spawn(command, ["acp", "--add-dir", cwd], cwd, h);
    },
    board: p.board,
    notify: (title, body) => void p.notifier.send({ title, body, path: "#/task-inbox", tags: ["inbox_tray"] }).catch(() => undefined),
    busy,
    me: { username: (() => {
      try {
        return userInfo().username;
      } catch {
        return undefined;
      }
    })(), home: homedir() },
  });
  inbox.start();
  return inbox;
}

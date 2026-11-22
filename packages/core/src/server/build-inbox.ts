import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { homedir, setPriority, userInfo } from "node:os";
import { join } from "node:path";
import { AGENT_GIT_IDENTITY, searchWeb, webFetchTool, type ToolContext } from "@kesher/agent";
import type { ProviderRegistry } from "@kesher/providers";
import type { InboxBusy } from "@kesher/shared";
import { AcpAgent } from "../acp.js";
import { agyPath } from "../agy-path.js";
import type { KesherConfig } from "../config.js";
import { modelTurnFor, withFilter } from "../conversations.js";
import { researchReport } from "../deep-research.js";
import type { FreeCloudPool } from "../free-cloud.js";
import type { GpuGuard } from "../gpu-guard.js";
import { busyPrograms, gameFoldersForBusy, inboxBusy, runningPrograms } from "../inbox-busy.js";
import { TaskInbox, isQuotaError, type RunCmd } from "../inbox-runner.js";
import type { Notifier } from "../notify.js";
import { commandPlan, findGit, gitPlan, startErrorText } from "../inbox-spawn.js";
import { findGamesAndStoreApps } from "../pc-games.js";
import type { TaskBoard } from "../task-board.js";

/**
 * Runs a program at (optionally) low priority, keeping up to 4 MB of output (a diff or a task file must not be cut).
 *
 * @param kind - "git": the arguments are git's own and git runs as itself, never through a shell (on Windows the
 *   inbox once ran `fetch …` through cmd.exe and never got a task); "run": a check command, program first
 *   (inbox-spawn.ts `commandPlan`).
 * @param lowPriority - Lower the child's priority (checks and builds), so the PC stays responsive.
 */
function runner(kind: "git" | "run", lowPriority: boolean): RunCmd {
  let git: string | undefined;
  return (cwd, args, timeoutMs = 10 * 60_000) =>
    new Promise((resolve) => {
      const plan = kind === "git" ? gitPlan((git ??= findGit()), args) : commandPlan(args);
      if ("refused" in plan) return resolve({ code: -1, out: plan.refused });
      const isGit = kind === "git" || /^git(\.exe)?$/i.test(plan.program);
      let out = "";
      const child = spawn(plan.program, plan.args, { cwd, shell: plan.shell, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...AGENT_GIT_IDENTITY } });
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
        // Git not installed: look for it again next time (it may be installed while KesherAI runs).
        if (kind === "git" && (e as NodeJS.ErrnoException).code === "ENOENT") git = undefined;
        resolve({ code: -1, out: startErrorText(e, isGit) });
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
 * @param p - The config, data folder, board, notifier, the graphics card guard and the provider registry (small research
 *   tasks run on its "gemini" provider).
 * @returns The inbox (fetching starts when it is on).
 */
export function buildTaskInbox(p: { config: KesherConfig; root: string; board: TaskBoard; notifier: Notifier; guard: GpuGuard; registry: ProviderRegistry; freeCloud?: FreeCloudPool }): TaskInbox {
  const git = runner("git", false);
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
    run: runner("run", true),
    // The unmodified Antigravity CLI in ACP mode, in the task's worktree only; no token or key passes through KesherAI.
    startAgent: async (cwd, h) => {
      const local = agyPath();
      const command = local && (await stat(local).catch(() => undefined)) ? local : "agy";
      return AcpAgent.spawn(command, ["acp", "--add-dir", cwd], cwd, h);
    },
    // Small research tasks (route B) run by themselves on the user's free "gemini" provider (a free AI Studio key).
    // That key must stay without a billing account, so it can never charge; a limit error defers the task.
    // Generalized to the free cloud: the Gemini key first, and when it is at its limit or busy, the free cloud helpers
    // (Groq, OpenRouter :free, Cloudflare, Mistral, Zhipu) in the user's order, inside their free limits.
    research: {
      ready: () => !!p.registry.get("gemini") || !!p.freeCloud?.candidates("background").length,
      run: async (question, signal) => {
        const prefs = withFilter(undefined, p.config.webFilter, false);
        const tools = { search: (q: string, sig: AbortSignal) => searchWeb(q, prefs, sig), read: async (url: string, sig: AbortSignal) => (await webFetchTool.run({ url }, { signal: sig, web: prefs } as unknown as ToolContext)).output };
        const viaPool = () => researchReport(question, { model: p.freeCloud!.turn("background"), ...tools }, signal);
        const provider = p.registry.get("gemini");
        if (!provider) {
          if (!p.freeCloud) throw new Error("No Gemini connection.");
          return viaPool();
        }
        try {
          return await geminiResearch(provider);
        } catch (e) {
          // Gemini's limit or a busy answer is not the end: the free cloud helpers go on (never a paid one).
          if (signal.aborted || !p.freeCloud || !p.freeCloud.candidates("background").length || !(isQuotaError((e as Error).message) || /\b(500|502|503|504)\b|UNAVAILABLE|overloaded/i.test((e as Error).message))) throw e;
          return viaPool();
        }
        async function geminiResearch(provider: NonNullable<ReturnType<typeof p.registry.get>>): Promise<string> {
        const models = await provider.listModels(signal);
        // Google keeps listing retired models (Gemini 2.5 answers 404 since Oct 2026), and the free tier's busiest model
        // often answers 503 "overloaded": try, in order, flash-latest, the newest numbered Flash, flash-lite-latest and the
        // largest Gemma, moving on only when Google says it is busy (a quota or billing error stops at once).
        const chat = models.filter((m) => m.category === "chat" && !/image|tts|live|preview|exp|embed/i.test(m.providerModelId));
        const ver = (id: string) => Number(/(?:gemini|gemma)-(\d+(?:\.\d+)?)/.exec(id)?.[1] ?? 0);
        const size = (id: string) => Number(/(\d+)b(?:-|$)/i.exec(id)?.[1] ?? 0);
        const flash = chat.filter((m) => /flash/i.test(m.providerModelId) && !/lite/i.test(m.providerModelId));
        const order = [
          flash.find((m) => /flash-latest$/i.test(m.providerModelId)),
          [...flash].sort((x, y) => ver(y.providerModelId) - ver(x.providerModelId))[0],
          chat.find((m) => /flash-lite-latest$/i.test(m.providerModelId)),
          [...chat.filter((m) => /gemma/i.test(m.providerModelId))].sort((x, y) => ver(y.providerModelId) - ver(x.providerModelId) || size(y.providerModelId) - size(x.providerModelId))[0],
          chat[0],
        ].filter((m, i, all): m is NonNullable<typeof m> => !!m && all.findIndex((x) => x?.id === m.id) === i);
        if (!order.length) throw new Error("The Gemini connection lists no chat model.");
        let last: Error | undefined;
        for (const pick of order) {
          try {
            return await researchReport(question, {
              model: modelTurnFor(p.registry, pick.id, undefined, "helper"),
              ...tools,
            }, signal);
          } catch (e) {
            last = e as Error;
            if (signal.aborted || !/\b(500|502|503|504)\b|UNAVAILABLE|overloaded/i.test(last.message)) throw last;
          }
        }
        throw last ?? new Error("Gemini is busy.");
        }
      },
    },
    board: p.board,
    notify: (title, body, opts) => void p.notifier.send({ title, body, path: opts?.path ?? "#/task-inbox", tags: ["inbox_tray"], ...(opts?.actions ? { actions: opts.actions } : {}), ...(opts?.ref ? { ref: opts.ref } : {}) }).catch(() => undefined),
    // A running Antigravity task's live progress: the phone app only (one notification per task, updated in place).
    progress: (n) => void p.notifier.phone({ title: n.title, body: n.body, ref: n.ref, path: `#/task-inbox/${n.taskId}`, tags: ["inbox_tray"], progress: n.progress }).catch(() => undefined),
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

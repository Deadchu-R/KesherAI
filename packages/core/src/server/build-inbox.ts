import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { homedir, setPriority, userInfo } from "node:os";
import { join } from "node:path";
import { AGENT_GIT_IDENTITY, searchWeb, webFetchTool, type ToolContext } from "@kesher/agent";
import type { ProviderRegistry } from "@kesher/providers";
import { FREE_PROVIDERS, OPENCODE_PROVIDER, inboxModelAllowed, type InboxBusy } from "@kesher/shared";
import { fetchFreeUsage } from "../openrouter-free.js";
import { AcpAgent } from "../acp.js";
import { agyPath } from "../agy-path.js";
import type { KesherConfig } from "../config.js";
import { modelTurnFor, withFilter, type ConversationManager } from "../conversations.js";
import { researchReport } from "../deep-research.js";
import type { FreeCloudPool } from "../free-cloud.js";
import type { GpuGuard } from "../gpu-guard.js";
import { busyPrograms, gameFoldersForBusy, inboxBusy, runningPrograms } from "../inbox-busy.js";
import { TaskInbox, isQuotaError, type RunCmd, type TaskInboxDeps } from "../inbox-runner.js";
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
 * OpenCode Go code tasks for the inbox (the `opencode` executor): each task runs in its own code chat the way
 * self-work's do (auto mode, unattended, in the task's worktree), on an `opencode-go/<model>` model through the
 * user's saved connection. No key passes through here: the chat uses the connection as any chat does.
 *
 * @param p - The config, the provider registry and the chats.
 * @returns The inbox's `coder`.
 */
export function opencodeCoder(p: { config: KesherConfig; registry: ProviderRegistry; chats: () => ConversationManager }): NonNullable<TaskInboxDeps["coder"]> {
  let cache: { at: number; list: string[] } | undefined;
  return {
    ready: () => !!p.registry.get(OPENCODE_PROVIDER) && !!p.config.providers.find((x) => x.id === OPENCODE_PROVIDER)?.apiKey,
    // The connection's chat models, asked at most every 10 minutes (the settings card's pickers).
    models: async () => {
      if (cache && Date.now() - cache.at < 10 * 60_000) return cache.list;
      const provider = p.registry.get(OPENCODE_PROVIDER);
      if (!provider) return [];
      const list = (await provider.listModels(AbortSignal.timeout(5000))).filter((m) => m.category === "chat").map((m) => m.id);
      cache = { at: Date.now(), list };
      return list;
    },
    // The free services (OpenRouter, Z.ai, Mistral, NVIDIA): each connection's chat models (asked at most every 10 minutes)
    // and, for OpenRouter, today's free request count (at most once a minute). The key is read only for that one call.
    free: Object.fromEntries(
      FREE_PROVIDERS.filter((f) => f.id !== OPENCODE_PROVIDER).map((f) => {
        let list: { at: number; ids: string[] } | undefined;
        let use: { at: number; v: Awaited<ReturnType<typeof fetchFreeUsage>> } | undefined;
        const key = () => p.config.providers.find((x) => x.id === f.id)?.apiKey;
        return [
          f.id,
          {
            ready: () => !!p.registry.get(f.id) && !!key(),
            models: async () => {
              if (list && Date.now() - list.at < 10 * 60_000) return list.ids;
              const provider = p.registry.get(f.id);
              if (!provider) return [];
              const ids = (await provider.listModels(AbortSignal.timeout(5000))).filter((m) => m.category === "chat").map((m) => m.id);
              list = { at: Date.now(), ids };
              return ids;
            },
            ...(f.id === "openrouter"
              ? {
                  usage: async () => {
                    if (use && Date.now() - use.at < 60_000) return use.v;
                    const k = key();
                    use = { at: Date.now(), v: k ? await fetchFreeUsage(k) : undefined };
                    return use.v;
                  },
                }
              : {}),
          },
        ];
      }),
    ),
    run: async ({ worktree, title, prompt, model, signal, onStep }) => {
      // Only models the inbox may use run here (the free ones of OpenRouter, Z.ai, ...): a last guard. The runner has
      // already checked the task itself for the services that may train; here only the setting is known.
      if (!inboxModelAllowed(model, p.config.taskInbox?.opencode?.freeTrainingOk !== false)) throw new Error(`The task inbox may not use ${model}.`);
      const chats = p.chats();
      const c = await chats.create({ kind: "code", workspace: worktree, mode: "auto", title, modelId: model });
      const session = async () => (await chats.open(c.id))?.session;
      // No one watches it: its questions and access requests are answered at once, as for self-work.
      (await session())?.setUnattended(true);
      signal.addEventListener("abort", () => chats.stop(c.id), { once: true });
      await chats.send(c.id, prompt);
      const startedAt = Date.now();
      let steps = -1;
      for (;;) {
        await new Promise((r) => setTimeout(r, 2000));
        if (signal.aborted) throw new Error("Stopped.");
        const s = await session();
        if (!s) throw new Error("The OpenCode Go chat is gone.");
        const status = s.info().status;
        const events = s.events;
        const n = events.reduce((k, e) => (e.type === "tool_call" ? k + 1 : k), 0);
        if (n !== steps) onStep((steps = n));
        if (status === "running" || status === "waiting") continue;
        // The turn may not have started yet right after the send.
        if (status === "idle" && !events.some((e) => e.type === "assistant") && Date.now() - startedAt < 15_000) continue;
        if (status === "error") {
          const last = [...events].reverse().find((e) => e.type === "status" && e.status === "error");
          throw new Error((last && last.type === "status" && last.message) || "The OpenCode Go model failed.");
        }
        const answer = [...events].reverse().find((e) => e.type === "assistant");
        return { text: answer && answer.type === "assistant" ? answer.text : "" };
      }
    },
  };
}

/**
 * Builds the task inbox: git and checks as argument lists, the unmodified `agy acp` (it signs in by itself), the
 * shared board, notifications to this PC and the phone, and the busy check (games, editors, the graphics card).
 *
 * @param p - The config, data folder, board, notifier, the graphics card guard and the provider registry (small research
 *   tasks run on its "gemini" provider), and the chats (OpenCode Go code tasks run in code chats).
 * @returns The inbox (fetching starts when it is on).
 */
export function buildTaskInbox(p: { config: KesherConfig; root: string; board: TaskBoard; notifier: Notifier; guard: GpuGuard; registry: ProviderRegistry; freeCloud?: FreeCloudPool; chats?: () => ConversationManager }): TaskInbox {
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
    ...(p.chats ? { coder: opencodeCoder({ config: p.config, registry: p.registry, chats: p.chats }) } : {}),
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

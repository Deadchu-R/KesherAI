import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { homedir, setPriority, userInfo } from "node:os";
import { join } from "node:path";
import { AGENT_GIT_IDENTITY, searchWeb, webFetchTool, type ModelTurn, type ToolContext } from "@kesher/agent";
import type { ProviderRegistry } from "@kesher/providers";
import { FREE_PROVIDERS, RELAY_PROVIDERS, OPENCODE_PROVIDER, inboxModelAllowed, trainingRiskOf, type InboxBusy } from "@kesher/shared";
import { UsageLog } from "../usage-log.js";
import type { WatchdogModel } from "../watchdog-model.js";
import { fetchFreeUsage } from "../openrouter-free.js";
import { AcpAgent } from "../acp.js";
import { agyPath } from "../agy-path.js";
import { checkClaude, claudeArgs, claudeEnv, claudeOnce, fileExists, findClaude, mergeClaudeLimit, readClaudeQuota, runClaude, writeClaudeSettings } from "../claude-exec.js";
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
import { githubTokenEnv } from "../git-credential.js";
import type { TaskBoard } from "../task-board.js";
import { readAntigravityQuota } from "../antigravity-quota.js";

/** git commands that talk to the remote (the only ones given the GitHub token). */
const NETWORK_GIT = new Set(["push", "fetch", "pull", "ls-remote"]);

/**
 * Runs a program at (optionally) low priority, keeping up to 4 MB of output (a diff or a task file must not be cut).
 *
 * @param kind - "git": the arguments are git's own and git runs as itself, never through a shell (on Windows the
 *   inbox once ran `fetch …` through cmd.exe and never got a task); "run": a check command, program first
 *   (inbox-spawn.ts `commandPlan`).
 * @param lowPriority - Lower the child's priority (checks and builds), so the PC stays responsive.
 * @param extraEnv - Extra environment for one run, from its arguments.
 */
function runner(kind: "git" | "run", lowPriority: boolean, extraEnv: (args: string[]) => Record<string, string> = () => ({})): RunCmd {
  let git: string | undefined;
  return (cwd, args, timeoutMs = 10 * 60_000) =>
    new Promise((resolve) => {
      const plan = kind === "git" ? gitPlan((git ??= findGit()), args) : commandPlan(args);
      if ("refused" in plan) return resolve({ code: -1, out: plan.refused });
      const isGit = kind === "git" || /^git(\.exe)?$/i.test(plan.program);
      let out = "";
      const child = spawn(plan.program, plan.args, { cwd, shell: plan.shell, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...AGENT_GIT_IDENTITY, ...extraEnv(args) } });
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
      [...FREE_PROVIDERS, ...RELAY_PROVIDERS].filter((f) => f.id !== OPENCODE_PROVIDER).map((f) => {
        let list: { at: number; ids: string[] } | undefined;
        let use: { at: number; v: Awaited<ReturnType<typeof fetchFreeUsage>> } | undefined;
        // Connections keep their key in the config; the free cloud helpers' (`fc-…`) live with their own registry entry.
        const key = () => p.config.providers.find((x) => x.id === f.id)?.apiKey ?? p.registry.list().find((r) => r.config.id === f.id)?.config.apiKey;
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
            // A small "reply with ok" (the relay's availability check): the answer's text, or a throw.
            probe: async (model: string, signal: AbortSignal) => {
              const provider = p.registry.get(f.id);
              if (!provider?.chatWithTools) throw new Error("This connection cannot chat.");
              const r = await provider.chatWithTools({ providerModelId: model.slice(f.id.length + 1), messages: [{ role: "user", content: "Reply with: ok" }], tools: [], maxTokens: 1024 }, signal);
              return r.text;
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
    run: async ({ worktree, title, prompt, model, signal, onStep, attach }) => {
      // Only models the inbox may use run here (the free ones of OpenRouter, Z.ai, ...): a last guard. The runner has
      // already checked the task itself for the services that may train; here only the setting is known.
      // The relay's models pass here: the runner already checked the task with safeForRelay and the relay's last answer.
      if (!inboxModelAllowed(model, p.config.taskInbox?.opencode?.freeTrainingOk !== false, true)) throw new Error(`The task inbox may not use ${model}.`);
      const chats = p.chats();
      const c = await chats.create({ kind: "code", workspace: worktree, mode: "auto", title, modelId: model });
      const session = async () => (await chats.open(c.id))?.session;
      // No one watches it: its questions and access requests are answered at once, as for self-work.
      (await session())?.setUnattended(true);
      signal.addEventListener("abort", () => chats.stop(c.id), { once: true });
      await chats.send(c.id, prompt);
      // The run guard's rescue hint joins the running turn at its next step (steer).
      attach?.(async (text) => void (await chats.send(c.id, text, { steer: true })));
      const startedAt = Date.now();
      let reported = 0;
      for (;;) {
        await new Promise((r) => setTimeout(r, 2000));
        if (signal.aborted) throw new Error("Stopped.");
        const s = await session();
        if (!s) throw new Error("The OpenCode Go chat is gone.");
        const status = s.info().status;
        const events = s.events;
        // Each new tool call is one step for the run guard: its tool, arguments and (when it failed) the error.
        const calls = events.filter((e): e is Extract<typeof e, { type: "tool_call" }> => e.type === "tool_call");
        for (; reported < calls.length; reported++) {
          const call = calls[reported]!;
          const res = events.find((e): e is Extract<typeof e, { type: "tool_result" }> => e.type === "tool_result" && e.callId === call.callId);
          onStep(reported + 1, { tool: call.name, args: call.input, ...(res && !res.ok ? { error: String(res.output).slice(0, 200) } : {}) });
        }
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
 * The second models of the run guard (agent-watch.ts): `ask` (a rescue hint, the end review) goes to the local chat model
 * when it is loaded and idle, else to the free cloud helpers (never a paid model); a pool whose services may train on
 * prompts is used only when `canTrain` says the text may go there. `look` (the watchdog) uses the small local router
 * model, on loan (CPU only, loaded for the check); when it is not on this computer the check is skipped.
 *
 * @param p - The config, the providers, the free cloud pool, which local chat model is loaded now and the watchdog's model.
 */
export function inboxHelpers(p: { config: KesherConfig; registry: ProviderRegistry; freeCloud?: FreeCloudPool; localChat?: () => string | undefined; watchdog?: WatchdogModel }): NonNullable<TaskInboxDeps["helpers"]> {
  const run = async (turn: ModelTurn, o: { system: string; prompt: string; signal: AbortSignal }): Promise<string> => {
    const signal = AbortSignal.any([o.signal, AbortSignal.timeout(60_000)]);
    const r = await turn({ messages: [{ role: "system", content: o.system }, { role: "user", content: o.prompt }], tools: [] }, signal, () => undefined);
    return r.text;
  };
  return {
    ask: async (o) => {
      const local = p.localChat?.();
      if (local) {
        try {
          return { text: await run(modelTurnFor(p.registry, local, { temperature: 0.2 }, "helper"), o), model: local };
        } catch {
          // Not loaded after all or busy: the free cloud helpers next.
        }
      }
      const pool = p.freeCloud;
      if (!pool?.candidates("background").length) return undefined;
      // A service that may train never gets what the task says it must not (the `:free` probe matches OpenRouter's rule).
      if (!o.canTrain && pool.candidates("background").some((id) => trainingRiskOf(`${id}/x:free`))) return undefined;
      try {
        return { text: await run(pool.turn("background"), o), model: "free cloud helper" };
      } catch {
        return undefined;
      }
    },
    // The watchdog's small model is on loan (watchdog-model.ts): CPU only, loaded for the check, unloaded after a minute.
    look: async (o) => p.watchdog?.ask(o.system, o.prompt, AbortSignal.any([o.signal, AbortSignal.timeout(60_000)])),
  };
}

/**
 * Claude Code on this PC for the inbox (the `claude` executor, claude-exec.ts): the user's own `claude` program and
 * login, KesherAI's status-line settings in its own folder (`<data>/claude-code`, never the user's global settings),
 * and the quota file that status line and the stream's rate-limit events write.
 *
 * @param p.root - KesherAI's data folder.
 * @returns The inbox's `claude`.
 */
export function claudeCode(p: { root: string }): NonNullable<TaskInboxDeps["claude"]> {
  const dir = join(p.root, "claude-code");
  const quotaFile = join(dir, "quota.json");
  // Looked up each time: Roee may install or sign in while KesherAI runs.
  const cli = () => findClaude({ platform: process.platform, env: process.env, home: homedir(), exists: fileExists });
  let files: ReturnType<typeof writeClaudeSettings> | undefined;
  return {
    check: async () => {
      const c = cli();
      return c ? checkClaude(claudeOnce(c, claudeEnv(process.env))) : { installed: false };
    },
    quota: () => readClaudeQuota(quotaFile),
    run: async (o) => {
      const c = cli();
      if (!c) throw new Error("Claude Code is not installed on this PC.");
      // Written once per start of KesherAI (the Node path changes with an update).
      const f = await (files ??= writeClaudeSettings(dir));
      return runClaude({
        cli: c,
        cwd: o.worktree,
        args: claudeArgs({ settings: f.settings, commands: o.commands, model: o.model }),
        prompt: o.prompt,
        env: claudeEnv(process.env),
        signal: o.signal,
        attach: o.attach,
        onEvent: (e) => {
          if (e.kind === "limit") void mergeClaudeLimit(f.quota, e, Date.now()).catch(() => undefined);
          o.onEvent(e);
        },
      });
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
export function buildTaskInbox(p: { config: KesherConfig; root: string; board: TaskBoard; notifier: Notifier; guard: GpuGuard; registry: ProviderRegistry; freeCloud?: FreeCloudPool; chats?: () => ConversationManager; localChat?: () => string | undefined; watchdog?: WatchdogModel; githubToken?: () => string | undefined; draining?: () => boolean }): TaskInbox {
  // The inbox's own fetches and pushes use the GitHub device sign-in's token when there is one (through the
  // environment only, never the remote URL); task programs ("run") never get it.
  const git = runner("git", false, (args) => {
    const token = NETWORK_GIT.has(args[0] ?? "") ? p.githubToken?.() : undefined;
    return token ? githubTokenEnv(token) : {};
  });
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
    ...(p.draining ? { draining: p.draining } : {}),
    file: join(p.root, "task-inbox.json"),
    // Antigravity's quota from its own local language server, read-only (antigravity-quota.ts).
    agQuota: (why) => readAntigravityQuota(why ? { why } : {}),
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
    claude: claudeCode({ root: p.root }),
    usage: new UsageLog(join(p.root, "usage-log")),
    helpers: inboxHelpers({ config: p.config, registry: p.registry, ...(p.freeCloud ? { freeCloud: p.freeCloud } : {}), ...(p.localChat ? { localChat: p.localChat } : {}), ...(p.watchdog ? { watchdog: p.watchdog } : {}) }),
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

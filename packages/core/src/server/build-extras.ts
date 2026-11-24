/**
 * The parts that work on their own (docs/ARCHITECTURE_REVIEW.md B6, first part): routines (at a time, every few
 * minutes, at start, or when a page, a folder or a download changes) that run a prompt, a pipeline or self-work.
 * Journal, computer control, Unreal, Unity and self-work follow.
 */
import { mkdir, readFile as readFileFs, rm as rmFs, writeFile as writeFileFs } from "node:fs/promises";
import { extname, join } from "node:path";
import { htmlToText } from "@kesher/agent";
import type { ProviderRegistry } from "@kesher/providers";
import type { DataPaths, KesherConfig } from "../config.js";
import { Journal, type ScreenSource } from "../journal.js";
import { modelTurnFor } from "../model-turn.js";
import type { ConversationManager } from "../conversations.js";
import type { Notifier } from "../notify.js";
import { Pipelines } from "../pipelines.js";
import type { Knowledge } from "../knowledge.js";
import type { Personas } from "../personas.js";
import { transcribeWith } from "../speech-tools.js";
import type { WhisperEngine } from "../whisper.js";
import { IMAGE_SUPPORT_FILE } from "../chat-tools-media.js";
import type { LlamaEngine } from "../llamacpp.js";
import { DEFAULT_ROUTINES, Routines } from "../routines.js";
import { buildDigest, DIGEST_FILE, digestSince } from "../inbox-digest.js";
import type { InboxState, InboxTaskView } from "@kesher/shared";
import { runIn } from "../run-in.js";
import { SelfWork } from "../self-work.js";
import type { KesherServerOptions } from "./options.js";
import type { TelegramBridge } from "../telegram.js";
import { UnityCli } from "../unity-cli.js";
import { GameCheckpoints } from "../game-checkpoints.js";
import type { SyncBatch } from "../game-sync.js";
import { suggestHeavyDir } from "../heavy-folder.js";
import { UnrealBridge } from "../unreal-bridge.js";
import { editorExe, findEngines, readProject } from "../unreal-install.js";
import { engineFor, runProgram } from "../unreal-tools.js";
import { localCall } from "../local-call.js";

/** The server, once made: a routine starts self-work through its route (same checks as the panel's Start). */
export interface InjectRef {
  app?: { inject: (o: { method: "POST"; url: string; payload: unknown; remoteAddress: string; headers: Record<string, string> }) => Promise<{ statusCode: number; json: () => unknown }> };
}

/**
 * The routines (not started).
 *
 * @param p - The data folders, pipelines, the server (for self-work's route), the chats (made later: read when a
 *   routine runs), the notifier, the settings and Telegram.
 * @returns The routines.
 */
export function buildRoutines(p: { paths: DataPaths; pipelines: Pipelines; injectRef: InjectRef; chats: () => ConversationManager; notifier: Notifier; config: KesherConfig; telegram: TelegramBridge; engine?: Pick<LlamaEngine, "note" | "status">; othersBusy?: () => boolean }): Routines {
  const { paths, pipelines, injectRef, chats, notifier, config, telegram, engine } = p;
  return new Routines(join(paths.root, "routines.json"), {
    runPipeline: async (id, inputs) => {
      const run = await pipelines.start(id, inputs);
      const done = await pipelines.wait(run.id);
      const files = done?.files.length ? ` Files: ${done.files.join(", ")}.` : "";
      return { ok: done?.status === "done", message: done?.status === "done" ? `Finished.${files}` : done?.error ?? "Stopped.", link: "#/pipelines" };
    },
    // The same checks as the panel's Start (through the route, so a worker is used when there is one).
    startSelfWork: async (o) => {
      if (!injectRef.app) return { ok: false, message: "KesherAI is still starting.", link: "#/code" };
      // Without a project and check the routine continues the last run's (chosen on this computer), else the inbox's project.
      const last = o.repo && o.check ? undefined : (await localCall<{ run?: { repo?: string; check?: string } | null }>(config.port, "GET", "/api/self-work").catch(() => undefined))?.json.run;
      const repo = o.repo ?? last?.repo ?? config.taskInbox.repo;
      if (!repo) return { ok: false, message: "Start self-work once on the Code page first, so the routine knows the project.", link: "#/code" };
      const start = { ...o, repo, check: o.check ?? last?.check ?? "pnpm -s typecheck && pnpm -s lint", goal: o.goal ?? "Work through the open small tasks on the shared task board (docs/WORK_LIST.md) one at a time: claim each before you start it and mark it done or blocked. When none is left, that is ALL DONE." };
      const r = await localCall<{ run?: { branch?: string; convId?: string }; error?: string }>(config.port, "POST", "/api/self-work/start", start).catch((err: Error) => ({ status: 0, json: { error: err.message } as { run?: { branch?: string; convId?: string }; error?: string } }));
      const body = r.json;
      return r.status === 200 && body.run ? { ok: true, message: `Self-work started on ${body.run.branch ?? "a new branch"}.`, link: "#/code" } : { ok: false, message: body.error ?? `It did not start (${r.status}).`, link: "#/code" };
    },
    // The task inbox through its own routes (as this computer): an Antigravity task is only asked about, never started.
    inboxRun: async (taskId) => {
      const link = "#/task-inbox";
      const path = `/api/task-inbox/tasks/${encodeURIComponent(taskId)}`;
      const t = await localCall<InboxTaskView & { error?: string }>(config.port, "GET", path).catch(() => undefined);
      if (!t || t.status !== 200) return { ok: false, message: t?.json.error ?? "KesherAI is still starting.", link };
      const answer = (r: { status: number; json: { error?: string } }, ok: string) => (r.status === 200 ? { ok: true, message: ok, link } : { ok: false, message: r.json.error ?? `It did not start (${r.status}).`, link });
      if (t.json.runBy === "antigravity") return answer(await localCall<{ error?: string }>(config.port, "POST", `${path}/ask`, {}), `Asked "Run this task in Antigravity?" for ${t.json.title}. It starts when you answer Run.`);
      const run = await localCall<{ error?: string }>(config.port, "POST", `${path}/run`, {});
      // Another task is running: wait in line instead.
      if (run.status === 409) return answer(await localCall<{ error?: string }>(config.port, "POST", `${path}/queue`, {}), `${t.json.title} is in line.`);
      return answer(run, `Started ${t.json.title}.`);
    },
    inboxSet: async (patch) => {
      const r = await localCall<{ error?: string }>(config.port, "PUT", "/api/task-inbox/settings", patch).catch((e: Error) => ({ status: 0, json: { error: e.message } }));
      const what = patch.loop !== undefined ? `The work loop is ${patch.loop ? "on" : "off"}.` : patch.paused ? "The task inbox is paused." : "The task inbox is running again.";
      return r.status === 200 ? { ok: true, message: what, link: "#/task-inbox" } : { ok: false, message: r.json.error ?? `It did not change (${r.status}).`, link: "#/task-inbox" };
    },
    // The digest: the inbox's state read through its route, written as one file (no model).
    digest: async () => {
      const link = "#/task-inbox";
      const st = await localCall<InboxState & { error?: string }>(config.port, "GET", "/api/task-inbox").catch(() => undefined);
      if (!st || st.status !== 200) return { ok: false, message: st?.json.error ?? "KesherAI is still starting.", link };
      const file = join(paths.root, DIGEST_FILE);
      const now = Date.now();
      const since = digestSince(await readFileFs(file, "utf8").catch(() => ""), now);
      const sw = (await localCall<{ run?: { status?: string; branch?: string; note?: string } | null }>(config.port, "GET", "/api/self-work").catch(() => undefined))?.json.run;
      await writeFileFs(file, buildDigest({ state: st.json, since, now, ...(sw?.status ? { selfWork: { status: sw.status, ...(sw.branch ? { branch: sw.branch } : {}), ...(sw.note ? { note: sw.note } : {}) } } : {}) }));
      return { ok: true, message: `Digest written (${st.json.tasks.length} tasks in the inbox).`, link };
    },
    runPrompt: async (name, prompt, modelId, personaId, opts = {}) => {
      // The engine log says who sent a request no chat on screen asked for.
      engine?.note(`the routine "${name}" started a chat (Routines page)`);
      const c = await chats().create({ kind: "chat", source: "routine", title: `${name} · ${new Date().toLocaleDateString("sv-SE")}`, ...(modelId ? { modelId } : {}), ...(personaId ? { personaId } : {}) });
      // A routine's folder (e.g. a list it keeps): created if missing, then opened to this chat's file tools.
      if (opts.folder) {
        await mkdir(opts.folder, { recursive: true });
        await (await chats().open(c.id))?.session.grant(opts.folder);
      }
      await chats().send(c.id, opts.folder ? `${prompt}\n\n(Your folder for this: ${opts.folder})` : prompt, opts.web ? { web: true } : {});
      const end = Date.now() + 30 * 60_000;
      for (;;) {
        await new Promise((r) => setTimeout(r, 1500));
        const opened = await chats().open(c.id);
        const st = opened?.session.info().status;
        if (st === "waiting") return { ok: true, message: "Waiting for your approval.", link: `#/c/${c.id}` };
        if (st !== "running" || Date.now() > end) {
          const last = [...(opened?.session.events ?? [])].reverse().find((e) => e.type === "assistant");
          const lastErr = [...(opened?.session.events ?? [])].reverse().find((e) => e.type === "status" && e.status === "error");
          const err = st === "error" && lastErr?.type === "status" ? lastErr.message : undefined;
          return { ok: st !== "error" && !!last, message: last && last.type === "assistant" ? last.text.replace(/\s+/g, " ").slice(0, 300) : err ? `It stopped: ${err.slice(0, 280)}` : "No answer.", link: `#/c/${c.id}` };
        }
      }
    },
    notify: async (title, body, path) => void (await notifier.send({ title, body: config.notifications.includeText ? body : body.length > 80 ? "Done — open KesherAI to read it." : body, path, tags: ["alarm_clock"] })),
    discard: async (link) => {
      const id = /^#\/c\/([\w-]+)$/.exec(link)?.[1];
      if (id) await chats().delete(id);
    },
    telegram: async (text) => telegram.broadcast(text),
    // Page routines: the page's readable text (20 s, 3 MB at most; http and https only, checked when saved).
    pageText: async (url) => {
      const res = await fetch(url, { signal: AbortSignal.timeout(20_000), headers: { "user-agent": "KesherAI page check" }, redirect: "follow" });
      if (!res.ok) throw new Error(`The page answered ${res.status}.`);
      const body = (await res.text()).slice(0, 3_000_000);
      return /html/i.test(res.headers.get("content-type") ?? "") ? htmlToText(body) : body;
    },
    // Also while another program works the graphics card hard (a game, a shader build): a background routine would
    // load a model under it.
    busy: () => Object.keys(chats().activity()).length > 0 || engine?.status().job?.phase === "loading" || !!p.othersBusy?.(),
  }, Date.now, DEFAULT_ROUTINES);
}

/**
 * Unity's CLI (the Unity page and the chat's Unity tools share it; looked for now, so the first chat has the tools)
 * and the Unreal bridge, which runs graph commands in a headless editor while Unreal is closed, never next to an
 * editor open on the same project without the plugin (two editors saving the same assets could lose work).
 *
 * @param paths - The data folders.
 * @param config - The Unity settings.
 * @param persist - Saves the settings.
 * @returns The Unity CLI and the Unreal bridge.
 */
export function buildGameEngines(paths: DataPaths, config: KesherConfig, persist: () => Promise<void>): { unityCli: UnityCli; unrealBridge: UnrealBridge; gameCheckpoints: GameCheckpoints } {
  // Unity's CLI: the Unity page and the chat's Unity tools share it.
  UnityCli.setLogFile(join(paths.root, "logs", "unity-cli.log"));
  const unityCli = new UnityCli(config.unity, persist, undefined, join(paths.root, "unity"));
  // Look for the CLI now, so the first chat already has the Unity tools.
  unityCli.cliKnown();
  const unrealBridge = new UnrealBridge(join(paths.root, "unreal"));
  const editorOpenOn = async (uproject: string): Promise<boolean> => {
    const name = uproject.split(/[\\/]/).pop()!.toLowerCase();
    const r =
      process.platform === "win32"
        ? await runProgram("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Get-CimInstance Win32_Process -Filter \"Name='UnrealEditor.exe' OR Name='UE4Editor.exe'\" | ForEach-Object { $_.CommandLine }"], { timeoutMs: 15_000 }).catch(() => ({ code: 1, out: "" }))
        : await runProgram("ps", ["-eo", "args"], { timeoutMs: 10_000 }).catch(() => ({ code: 1, out: "" }));
    return r.out.split(/\r?\n/).some((l) => /UnrealEditor(?!-Cmd)/i.test(l) && l.toLowerCase().includes(name));
  };
  // With Unreal closed, graph commands run in a headless editor (the plugin's KesherBridge commandlet).
  unrealBridge.setHeadless(async (projectFile, commands) => {
    const p = await readProject(projectFile);
    const e = engineFor(await findEngines(), p.engine);
    if (!e) throw new Error(`Unreal ${p.engine} is not installed on this computer.`);
    // Unreal open on this project without the plugin connected: a second editor saving the same assets could lose
    // work, so the change waits for the plugin instead.
    if (await editorOpenOn(p.file)) throw new Error("Unreal is open on this project but the KesherAI Bridge plugin is not connected.");
    const cmd = editorExe(e.path, true);
    const dir = join(p.dir, "Saved", "KesherAI");
    await mkdir(dir, { recursive: true });
    const request = join(dir, "bridge-request.json");
    const response = join(dir, "bridge-response.json");
    await rmFs(response, { force: true });
    await writeFileFs(request, JSON.stringify({ commands }));
    const r = await runProgram(cmd, [p.file, "-run=KesherBridge", "-unattended", "-nop4", "-nosplash", "-NullRHI", "-stdout"], { env: { ...process.env, KESHER_BRIDGE_REQUEST: request, KESHER_BRIDGE_RESPONSE: response }, timeoutMs: 900_000, lowPriority: true });
    const text = await readFileFs(response, "utf8").catch(() => "");
    if (!text) {
      const why = /Commandlet KesherBridge|KesherBridgeCommandlet|Could not find.*commandlet/i.test(r.out) ? "The KesherAI Bridge plugin in this project cannot work with Unreal closed yet: update it to 0.1.20 or newer from the Unreal page (Update the plugin), then try again." : r.out.split(/\r?\n/).filter((l) => /Error/i.test(l)).slice(-5).join("\n") || `The headless Unreal editor stopped (exit ${r.code}).`;
      throw new Error(why);
    }
    const j = JSON.parse(text) as { answers?: Array<{ ok: boolean; result?: unknown; error?: string }>; ok?: boolean; result?: unknown; error?: string };
    return j.answers ?? [j as { ok: boolean; result?: unknown; error?: string }];
  });
  // With Unreal closed, a gameplay test runs in a headless editor through Unreal's automation runner: the plugin's
  // automation test KesherAI.PlayTest.Request reads the plan file, plays it in PIE (no rendering, so no pictures) and
  // writes each step's result to the response file.
  unrealBridge.setHeadlessPlay(async (projectFile, plan) => {
    const p = await readProject(projectFile);
    const e = engineFor(await findEngines(), p.engine);
    if (!e) throw new Error(`Unreal ${p.engine} is not installed on this computer.`);
    if (await editorOpenOn(p.file)) throw new Error("Unreal is open on this project but the KesherAI Bridge plugin is not connected.");
    const cmd = editorExe(e.path, true);
    const dir = join(p.dir, "Saved", "KesherAI");
    await mkdir(dir, { recursive: true });
    const request = join(dir, "play-test-request.json");
    const response = join(dir, "play-test-response.json");
    await rmFs(response, { force: true });
    await writeFileFs(request, JSON.stringify(plan));
    const r = await runProgram(cmd, [p.file, "-ExecCmds=Automation RunTests KesherAI.PlayTest.Request; Quit", "-unattended", "-nop4", "-nosplash", "-NullRHI", "-stdout", "-testexit=Automation Test Queue Empty"], { env: { ...process.env, KESHER_PLAYTEST_REQUEST: request, KESHER_PLAYTEST_RESPONSE: response }, timeoutMs: 900_000 });
    const text = await readFileFs(response, "utf8").catch(() => "");
    if (!text) throw new Error(/No automation tests matched|KesherAI\.PlayTest/i.test(r.out) ? "The KesherAI Bridge plugin in this project cannot run gameplay tests with Unreal closed yet: update it to 0.1.25 or newer from the Unreal page." : r.out.split(/\r?\n/).filter((l) => /Error/i.test(l)).slice(-5).join("\n") || `The headless Unreal editor stopped (exit ${r.code}).`);
    return JSON.parse(text) as unknown;
  });
  // Checkpoints around engine writes, on the heavy-data drive (Roee: not on C:), else next to the models, else the data folder.
  const gameCheckpoints = new GameCheckpoints(
    () => join(config.heavyDir ?? suggestHeavyDir(paths.models, paths.root) ?? paths.root, "game-checkpoints"),
    () => config.gameCheckpoints,
  );
  // One checkpoint per sync batch: the graphs' asset files (binaries too) before the batch writes them.
  const beforeSync = async (b: SyncBatch) => {
    await gameCheckpoints.capture({ engine: b.engine, project: b.project, name: b.name, source: "sync", label: `Sync: ${b.count} change(s)`, group: `sync:${Date.now()}` }, b.files);
  };
  unityCli.beforeSync = beforeSync;
  unrealBridge.beforeSync = beforeSync;
  return { unityCli, unrealBridge, gameCheckpoints };
}

/**
 * "My day": off until the user turns it on; never leaves this computer. Its model is the one asked for, or the chat
 * model; it knows whether that model is local.
 *
 * @param paths - The data folders.
 * @param config - The active models.
 * @param registry - The providers.
 * @param screen - The desktop app's screen capture (no PowerShell, which antivirus programs block).
 * @returns The journal (loading in the background).
 */
export function buildJournal(paths: DataPaths, config: KesherConfig, registry: ProviderRegistry, screen?: ScreenSource): Journal {
  const journal = new Journal(join(paths.root, "journal"), (modelId) => {
    const id = modelId ?? config.activeModels.chat;
    if (!id) return undefined;
    try {
      const { provider } = registry.resolve(id);
      return { id, local: (provider as { location?: string }).location !== "cloud", turn: modelTurnFor(registry, id) };
    } catch {
      return undefined;
    }
  }, undefined, screen);
  void journal.load();
  journal.recordingDays = () => config.meetings.keepRecordingDays;
  return journal;
}

/**
 * Self-work (B6, last part): KesherAI works on a git project by itself, on its own branch, item by item, in its own
 * code chat. In the worker process it also stops between items when asked to move to a newer version, and ends after
 * 10 idle minutes (the main app starts it again for the next run).
 *
 * @param p - The data folders, the chats (made later), the notifier, the worker's settings (worker mode only) and
 *   the shared folder (board and handoff).
 * @returns Self-work (loading) and, in the worker, how to move it to a newer version.
 */
export function buildSelfWork(p: { paths: DataPaths; chats: () => ConversationManager; notifier: Notifier; worker: KesherServerOptions["worker"]; sharedDir: string }): { selfWork: SelfWork; upgrade?: () => void } {
  const { paths, chats, notifier, worker, sharedDir } = p;
  let workerUpgrade = false;
  const selfWork = new SelfWork(join(paths.root, "self-work.json"), {
    createChat: async (folder, title, modelId, extra = []) => {
      const c = await chats().create({ kind: "code", workspace: folder, mode: "auto", title, ...(modelId ? { modelId } : {}) });
      // No one watches self-work: its questions and access requests are answered at once (found on the PC: a run
      // waited hours on a request for a folder outside the project).
      (await chats().open(c.id))?.session.setUnattended(true);
      // The shared board and handoff: readable by this chat's file tools.
      for (const f of extra) {
        await mkdir(f, { recursive: true }).catch(() => undefined);
        await (await chats().open(c.id))?.session.grant(f);
      }
      return c.id;
    },
    send: async (id, text) => {
      (await chats().open(id))?.session.setUnattended(true);
      await chats().send(id, text);
    },
    state: async (id) => {
      const opened = await chats().open(id);
      const last = [...(opened?.session.events ?? [])].reverse().find((e) => e.type === "assistant");
      return { status: opened?.session.info().status ?? "error", last: last && last.type === "assistant" ? last.text : "", events: opened?.session.events.length ?? 0 };
    },
    stopTurn: (id) => chats().stop(id),
    // The chat's tokens so far (its usage events), for each self-work item's cost.
    tokens: async (id) => {
      const opened = await chats().open(id);
      return (opened?.session.events ?? []).reduce((n, e) => (e.type === "usage" ? n + (e.input ?? 0) + (e.output ?? 0) : n), 0);
    },
    git: (repo, args) => runIn(repo, "git", args, false),
    check: (repo, command) => runIn(repo, command, [], true),
    // The worker tells the main app, which has the phone notifications set up.
    notify: async (title, body, path) =>
      void (worker
        ? await fetch(`${worker.mainUrl.replace(/\/$/, "")}/api/self-work/notify`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title, body, path }), signal: AbortSignal.timeout(10_000) }).catch(() => undefined)
        : await notifier.send({ title, body, path, tags: ["robot"] }).catch(() => undefined)),
    shared: sharedDir,
    // Between items: a worker asked to move to a newer version stops here (its run continues in the new one).
    between: async () => {
      if (workerUpgrade) process.exit(75);
    },
  });
  void selfWork.load().catch(() => undefined);
  if (!worker) return { selfWork };
  // A worker with nothing to do for 10 minutes ends (the main app starts it again for the next run).
  let idleSince = Date.now();
  setInterval(() => {
    const r = selfWork.current;
    if (r && (r.status === "running" || r.status === "waiting")) idleSince = Date.now();
    else if (Date.now() - idleSince > 10 * 60_000) process.exit(0);
  }, 30_000).unref();
  return {
    selfWork,
    upgrade: () => {
      workerUpgrade = true;
      const r = selfWork.current;
      if (!r || (r.status !== "running" && r.status !== "waiting")) setTimeout(() => process.exit(75), 500);
    },
  };
}

/**
 * Pipelines (B6): chains of model calls and tools, with conditions and loops, saved in the data folder.
 *
 * @param p - The data folders, the settings, the models, the personas, the knowledge bases, the speech engine and the
 *   notifier (each pipeline step reaches what it needs through them).
 * @returns The pipelines.
 */
export function buildPipelines(p: { paths: DataPaths; config: KesherConfig; registry: ProviderRegistry; personas: Personas; knowledge: Knowledge; whisper: WhisperEngine; notifier: Notifier }): Pipelines {
  const { paths, config, registry, personas, knowledge, whisper, notifier } = p;
  return new Pipelines(join(paths.root, "pipelines"), join(paths.root, "outputs", "pipelines"), {
    ask: async ({ prompt, system, model, persona }, signal) => {
      await personas.load();
      const p = persona ? (await personas.list()).find((x) => x.id === persona || x.name.toLowerCase() === persona.toLowerCase()) : undefined;
      const id = model || p?.modelId || config.activeModels.chat;
      if (!id) throw new Error("No chat model is active. Pick one on the Models page.");
      const sys = [p?.instructions, system].filter(Boolean).join("\n\n");
      const r = await modelTurnFor(registry, id)({ messages: [...(sys ? [{ role: "system" as const, content: sys }] : []), { role: "user" as const, content: prompt }], tools: [] }, signal, () => undefined);
      return r.text.replace(/<think>[\s\S]*?<\/think>\s*/g, "").trim();
    },
    knowledge: async (query, base) => {
      const hits = await knowledge.search(query, base);
      return hits.map((h) => `[${h.source}${/^https?:/.test(h.source) ? "" : `, p. ${h.page}`}] ${h.text}`).join("\n\n") || "(nothing found)";
    },
    image: async ({ prompt, width, height }, signal) => {
      const id = config.activeModels.image;
      if (!id) throw new Error("No image model is active. Pick one on the Models page.");
      // A support file saved as the image model (found on the PC: a VAE): say so instead of a failed ComfyUI run.
      if (IMAGE_SUPPORT_FILE.test(id)) throw new Error(`The active image model (${id.split(/[\\/]/).pop()}) is part of a model, not one. Pick an image model on the Models page.`);
      const { provider, providerModelId } = registry.resolve(id);
      if (!provider.generateImage) throw new Error(`${id} does not make images.`);
      return provider.generateImage({ providerModelId, prompt, width: width ?? 1024, height: height ?? 1024, steps: 20, seed: Math.floor(Math.random() * 2 ** 31) }, signal);
    },
    transcribe: async (path) => {
      const ext = extname(path);
      const r = await transcribeWith({ whisper, speech: () => config.speech, providers: () => config.providers }, await readFileFs(path), /^\.(wav|mp3|flac|ogg)$/i.test(ext) ? ext : ".wav", config.speech.language);
      return r.text;
    },
    notify: async (title, body) => void (await notifier.send({ title, body, path: "#/pipelines", tags: ["gear"] })),
  });
}

import { freemem, totalmem } from "node:os";
import { readFile, readdir, stat } from "node:fs/promises";
import { heavyGate } from "../heavy-gate.js";
import { advise, parseBench, type CalAdvice, type CalRow } from "../calibrate.js";
import type { FastifyInstance } from "fastify";
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { RECOMMENDED_MODELS, ROUTER_MODEL, checkLoadSettings, suggestModel, type ModelLoadSettings, toolNeed, type ModelTool, type RecommendedModel } from "@kesher/shared";
import { detectHardware, detectHardwareCached, estimatePerformance, listHubFiles } from "@kesher/downloads";
import type { KesherServices } from "../services.js";
import { enginePlatform, findLlamaRelease, vulkanIcds, waitForDownload, type LoadKind, type LoadReason } from "../llamacpp.js";
import { insideAny, looksLikeGguf, matchRecommended, scanComputer, scanFolder, type FoundModel } from "../model-scan.js";
import { bySpeed, planGpus, type Gpu } from "../gpus.js";
import { RECOMMENDED_VIDEO_MODEL, comfyWanStatus, ensureImageModel, ensureVideoModel, setupComfyWan, videoStatus } from "../sdcpp.js";
import { BENCH_SET, BENCH_SYSTEM, benchRight } from "../bench-set.js";
import { SideEngine, sideEngineOf } from "../side-engine.js";

/**
 * Installs the llama.cpp engine if it is missing. Shared by the install
 * route and the one-click "run this model" route.
 *
 * @param s - Services.
 */
export async function ensureEngine(s: KesherServices): Promise<void> {
  const hw = await detectHardware();
  const platform = enginePlatform(hw);
  // Installed for the processor alone (an older KesherAI did not know AMD or Intel cards, or Vulkan was missing),
  // and now a card can be used: the right build replaces it, once.
  const bin = s.engine.status().binaryPath;
  const gpuLib = bin ? (await readdir(dirname(bin)).catch(() => [] as string[])).some((f) => /ggml-(cuda|vulkan|hip|sycl|opencl|metal)/i.test(f)) : true;
  const cpuOnly = s.config.engines.llamaBuild ? /, CPU/.test(s.config.engines.llamaBuild) : !gpuLib;
  const upgrade = s.engine.status().installed && process.platform === "linux" && cpuOnly && !!platform.vulkan;
  if (s.engine.status().installed && !upgrade) return;
  // The last model loads by itself at start, so the engine is often already running: stop it, replace the build,
  // and load the same model again on the card (found on a CachyOS computer: the upgrade never happened).
  const was = s.engine.status();
  if (upgrade && was.running) await s.engine.stop("Switching to the build for the graphics card");
  const { binaryPath, version, build } = await s.engine.install(s.downloads, platform);
  s.config.engines.llamaServerPath = binaryPath;
  s.config.engines.llamaVersion = version;
  if (build) s.config.engines.llamaBuild = build;
  await s.saveConfig();
  if (upgrade && was.running && was.modelPath) await loadModel(s, was.modelPath, undefined, { kind: "update" }).catch(() => undefined);
}

/** What the last look over this computer found (kept five minutes: the models page asks often, and big ComfyUI or Hugging Face folders take a while to walk). */
let found: { at: number; models: FoundModel[] } | undefined;

/**
 * GGUF models on this computer: KesherAI's own folder, the folders the user
 * added and other apps' folders (LM Studio, Ollama, Hugging Face…).
 *
 * @param s - Services.
 * @param fresh - Look again even if a recent look is kept.
 * @returns Models found.
 */
/** Forgets the last look (the user changed the model folders). */
export function forgetFoundModels(): void {
  found = undefined;
}

async function modelsOnComputer(s: KesherServices, fresh = false): Promise<FoundModel[]> {
  if (!fresh && found && Date.now() - found.at < 300_000) return found.models;
  const own = await scanFolder({ folder: join(s.paths.models, "chat"), source: "KesherAI" }).catch(() => []);
  const others = (await scanComputer(s.config.modelFolders).catch(() => [])).flatMap((f) => f.models);
  found = { at: Date.now(), models: [...own, ...others] };
  return found.models;
}

/** The engine log's words for each reason. */
const REASON_TEXT: Record<LoadKind, string> = {
  chosen: "chosen on the Models page or through the API",
  chat: "needed by a chat",
  request: "a request needed the model (not a chat: a title, a report, a pipeline or the phone)",
  startup: "the last model, at start-up",
  settings: "reload after a settings change",
  update: "back after an update",
  calibration: "back after calibration",
  setup: "first-run setup",
  benchmark: "a speed test",
  helper: "a sub-agent needed it",
};

/**
 * Loads a GGUF file in the engine, registers the `llamacpp` provider,
 * remembers it for the next start, and makes it the active chat model if
 * none is set.
 *
 * @param s - Services.
 * @param modelPath - Absolute path inside the models folder.
 * @param name - The id's name (default: the file's).
 * @param why - Who asked: for the engine log, and shown on screen (Models page, the computer's load) so a load nobody
 *   expected has a name (found on the PC: a model came back after restarts, cause unknown).
 * @returns The model id, e.g. `llamacpp/Qwen3-8B-Q4_K_M`.
 */
export async function loadModel(s: KesherServices, modelPath: string, name?: string, why: LoadReason = { kind: "chosen" }): Promise<string> {
  s.engine.note(`loading ${basename(modelPath)} (${why.kind === "helper" && why.back ? "back after a sub-agent" : REASON_TEXT[why.kind]}${why.chats?.length ? `: "${why.chats.join('", "')}"` : ""}${why.helper ? `: ${why.helperKind ? `${why.helperKind} agent` : "sub-agent"}, "${why.helper}"` : ""})`);
  s.engine.loadedFor = { ...why, at: Date.now() };
  // Before too: the guard checks every few seconds, and a load takes up to a minute; after a long idle time it
  // stopped the server while it was still loading (found on the PC: "stopped: unused for a while" twice in a row).
  s.guard.touch("llamacpp");
  // A big model (8 GB and more) is a heavy job: it waits for a running build or install, and they wait for it.
  const big = ((await stat(modelPath).catch(() => undefined))?.size ?? 0) >= 8 * 1024 ** 3;
  if (big) await heavyGate.run({ en: `loading ${basename(modelPath)}`, he: `טעינת המודל ${basename(modelPath)}` }, () => s.engine.load(modelPath));
  else await s.engine.load(modelPath);
  // A model just loaded is in use: without this, the idle unloader (20 minutes by default) stopped it seconds after
  // loading when nothing had run for a while (found on the PC: Qwen3.6 loaded, then unloaded 3 s later).
  s.guard.touch("llamacpp");
  s.registerEngineProvider();
  const modelId = `llamacpp/${(name ?? basename(modelPath)).replace(/\.gguf$/i, "").replace(/[\s/]+/g, "-")}`;
  // Another load finished after this one began (found on the PC: an automatic reload of the old model raced the user's
  // own load; the engine ended on the user's model but the settings said the old one, which came back after a restart).
  if (s.engine.status().modelPath !== modelPath) return modelId;
  s.config.engines.lastModel = modelPath;
  s.config.engines.lastUnloaded = false;
  if (!s.config.activeModels.chat || s.config.activeModels.chat.startsWith("llamacpp/")) s.config.activeModels.chat = modelId;
  await s.saveConfig();
  return modelId;
}

/** Models load only from KesherAI's models folder or a folder the user added. */
function allowedModelPath(s: KesherServices, path: string): boolean {
  return insideAny(path, [s.paths.models, ...s.config.modelFolders.map((f) => f.folder)]);
}

/**
 * The built-in engine: install llama.cpp, load and stop models, and the
 * one-click "Start here" models.
 *
 * @param app - Fastify instance.
 * @param s - Services.
 */
export async function engineRoutes(app: FastifyInstance, s: KesherServices): Promise<void> {
  // A second model beside the main one (audit F19): loaded only when asked, never remembered.
  let sideEngine: SideEngine | undefined;
  const side = () => (sideEngine ??= sideEngineOf(s.registry, () => new SideEngine({ dir: s.paths.engines, binary: () => s.engine.status().binaryPath, ...(s.config.engines.llamaVersion ? { version: s.config.engines.llamaVersion } : {}), args: s.config.engines.llamaServerArgs, registry: s.registry })));
  app.addHook("onClose", async () => sideEngine?.stop());
  app.get("/api/engines/beside", async () => side().status());
  app.post<{ Body: { modelPath?: string } }>("/api/engines/beside/load", async (req, reply) => {
    const path = req.body?.modelPath ?? "";
    if (!allowedModelPath(s, path)) return reply.code(400).send({ error: "Only models in KesherAI's models folder or a folder you added can be loaded" });
    if (!(await looksLikeGguf(path))) return reply.code(400).send({ error: "Only GGUF files load in the engine" });
    if (s.engine.status().modelPath === path) return reply.code(400).send({ error: "This model is already the main one." });
    try {
      return { modelId: await side().load(path) };
    } catch (err) {
      return reply.code(500).send({ error: (err as Error).message });
    }
  });
  app.post("/api/engines/beside/stop", async () => {
    await side().stop();
    return side().status();
  });

  // "Auto"'s router model (Settings › Models › Auto): recommended, never downloaded by itself; one click downloads it
  // (when it is not on the computer yet) and loads it beside the main model.
  let routerJob: { phase: "downloading" | "loading" | "error"; message?: string } | undefined;
  const routerState = async () => {
    const copy = matchRecommended(await modelsOnComputer(s), ROUTER_MODEL.repo, ROUTER_MODEL.filePattern);
    const b = side().status();
    return { model: { name: ROUTER_MODEL.name, sizeGb: ROUTER_MODEL.sizeGb, note: ROUTER_MODEL.note }, downloaded: !!copy, beside: b.running && b.modelId ? b.modelId : null, ...(routerJob ? { job: routerJob } : {}) };
  };
  app.get("/api/model-router/router", async () => routerState());
  app.post("/api/model-router/router/setup", async (_req, reply) => {
    if (routerJob && routerJob.phase !== "error") return reply.code(409).send({ error: "Already setting it up." });
    if (!s.engine.status().binaryPath) return reply.code(409).send({ error: "Install the engine first (Models → Chat)." });
    routerJob = { phase: "downloading" };
    void (async () => {
      let path = matchRecommended(await modelsOnComputer(s, true), ROUTER_MODEL.repo, ROUTER_MODEL.filePattern)?.path;
      if (!path) {
        const files = await listHubFiles(ROUTER_MODEL.repo, { ...(s.config.huggingFaceToken ? { token: s.config.huggingFaceToken } : {}) });
        const file = files.find((f) => new RegExp(ROUTER_MODEL.filePattern, "i").test(f.path));
        if (!file) throw new Error(`No file matching ${ROUTER_MODEL.filePattern} in ${ROUTER_MODEL.repo}`);
        path = join(s.paths.models, "chat", ROUTER_MODEL.repo, file.path);
        if (!existsSync(path)) {
          const job = s.downloads.enqueue({ url: file.url, dest: path, size: file.size, ...(file.sha256 ? { sha256: file.sha256 } : {}), label: `${ROUTER_MODEL.name} · ${file.path}` });
          await waitForDownload(s.downloads, job.id);
        }
      }
      routerJob = { phase: "loading" };
      await side().load(path);
      routerJob = undefined;
    })().catch((err: Error) => {
      routerJob = { phase: "error", message: err.message };
    });
    return reply.code(202).send(await routerState());
  });

  app.get("/api/engines/llamacpp", async () => ({ ...s.engine.status(), fitTargetMiB: s.config.engines.fitTargetMiB ?? 2048, lastModel: s.config.engines.lastModel ? basename(s.config.engines.lastModel) : null }));

  /**
   * "Check the graphics card": what KesherAI sees and which engine build it uses, in one place, to read out or
   * send when a card is not used (AMD and Intel on Linux need Vulkan's driver; the log says whether the engine
   * found the card).
   */
  app.get("/api/engines/gpu-check", async () => {
    const hw = await detectHardware();
    const platform = enginePlatform(hw);
    const bin = s.engine.status().binaryPath;
    const libs = bin ? (await readdir(dirname(bin)).catch(() => [] as string[])).filter((f) => /ggml/i.test(f)) : [];
    const log = (s.engine.status().log ?? []).filter((l) => /^KesherAI:/.test(l) || /vulkan|ggml_vk|offload|gpu|device|layers to/i.test(l)).slice(-25);
    return {
      gpus: hw.gpus.map((g) => ({ name: g.name, vendor: g.vendor ?? "", vramGb: Math.round((g.vramTotal / 1024 ** 3) * 10) / 10 })),
      platform,
      vulkanDrivers: process.platform === "linux" ? vulkanIcds() : [],
      build: s.config.engines.llamaBuild ?? "",
      engineLibs: libs,
      engineLog: log,
    };
  });

  /**
   * The graphics cards and how models use them: each card (PCI order, memory,
   * compute capability, fastest first marked), the user's choice, and what
   * that choice does for a model of a given size (`?modelGb=`).
   */
  // "This tool works better with another model" (FUTURE: tools suggest a better model): one suggestion for the tool,
  // or none. Only the built-in engine's model is judged; a cloud or other provider's chat model gets no suggestion.
  app.get<{ Querystring: { tool?: string; lang?: string } }>("/api/models/suggest", async (req, reply) => {
    const tool = req.query.tool;
    if (tool !== "study" && tool !== "chat-report" && tool !== "code") return reply.code(400).send({ error: "Unknown tool." });
    const active = s.config.activeModels.chat;
    const st = s.engine.status();
    if (active && !active.startsWith("llamacpp/")) return { suggestion: null };
    const hw = await detectHardwareCached();
    // The Models page's own estimate for this computer (speed, and whether all of it fits on the graphics card).
    const speed = (sizeGb: number, activeFraction?: number) => {
      const e = estimatePerformance(sizeGb * 1024 ** 3, hw, activeFraction ? { activeFraction } : {});
      // The same room the estimate leaves on the largest card (context and desktop beside the weights).
      const vram = Math.max(0, ...hw.gpus.map((g) => g.vramTotal)) / 1024 ** 3;
      return { tokensPerSecond: e.tokensPerSecond, fitsGpu: vram * 0.9 - 1 >= sizeGb * 1.1 };
    };
    const local = (await s.localModels?.().catch(() => [])) ?? [];
    const name = st.modelPath ? basename(st.modelPath) : active ? active.slice("llamacpp/".length) : undefined;
    const size = local.find((m) => m.path === st.modelPath)?.size;
    const loaded = { ...(name ? { name } : {}), ...(size ? { size } : {}), ...(st.slotTokens ? { slotTokens: st.slotTokens } : {}) };
    const suggestion = suggestModel(toolNeed(tool as ModelTool, req.query.lang === "he"), loaded, local, speed) ?? null;
    return { suggestion, loaded: loaded.name ?? null };
  });

  app.get<{ Querystring: { modelGb?: string } }>("/api/engines/gpus", async (req) => {
    const hw = await detectHardwareCached();
    const gpus: Gpu[] = hw.gpus
      .filter((g) => /nvidia|geforce|rtx|gtx|quadro|tesla/i.test(g.name))
      .map((g, i) => ({ index: g.index ?? i, name: g.name, vramTotal: g.vramTotal, vramFree: g.vramFree, ...(g.computeCap ? { computeCap: g.computeCap } : {}) }));
    const fastest = bySpeed(gpus)[0]?.index;
    const gb = Number(req.query.modelGb ?? 0);
    const examples = [...new Set([gb || 8, 30, 70])].map((size) => {
      const plan = planGpus(gpus, s.config.engines.gpus, size * 1024 ** 3);
      return { modelGb: size, leader: plan.cards[0] ?? null, parts: plan.parts };
    });
    return { gpus: gpus.map((g) => ({ ...g, fastest: g.index === fastest })), prefs: s.config.engines.gpus, comfyGpu: s.config.comfyui.gpu ?? null, examples, current: s.engine.status().gpus ?? null };
  });

  /** Sets how models use the cards: `{ mode, use?, split?, main? }`. Applies the next time a model loads. */
  app.put<{ Body: { mode?: "auto" | "fastest" | "all"; use?: number[] | null; split?: number[] | null; main?: number | null } }>("/api/engines/gpus", async (req, reply) => {
    const b = req.body ?? {};
    const g = s.config.engines.gpus;
    if (b.mode) {
      if (!["auto", "fastest", "all"].includes(b.mode)) return reply.code(400).send({ error: "mode is auto, fastest or all" });
      g.mode = b.mode;
    }
    for (const key of ["use", "split", "main"] as const) {
      if (b[key] === null) delete g[key];
      else if (b[key] !== undefined) (g as Record<string, unknown>)[key] = b[key];
    }
    await s.saveConfig();
    return { ok: true, prefs: g };
  });

  /**
   * Two cards, the work split: `{ chat, comfy }` card indices (chat models on one card, ComfyUI on the other), or
   * `{ chat: null, comfy: null }` for all together. A running ComfyUI starts again on its card; a loaded chat model
   * moves at its next load.
   */
  app.put<{ Body: { chat?: number | null; comfy?: number | null } }>("/api/engines/gpu-split", async (req, reply) => {
    const b = req.body ?? {};
    const cards = (await detectHardwareCached()).gpus.filter((g) => /nvidia|geforce|rtx|gtx|quadro|tesla/i.test(g.name)).map((g, i) => g.index ?? i);
    const ok = (x: unknown): x is number => typeof x === "number" && cards.includes(x);
    if (b.chat === null && b.comfy === null) {
      delete s.config.engines.gpus.use;
      delete s.config.engines.gpus.split;
      delete s.config.comfyui.gpu;
    } else {
      if (!ok(b.chat) || !ok(b.comfy) || b.chat === b.comfy) return reply.code(400).send({ error: "Choose two different graphics cards." });
      s.config.engines.gpus.use = [b.chat];
      delete s.config.engines.gpus.split;
      s.config.comfyui.gpu = b.comfy;
    }
    await s.saveConfig();
    const was = s.comfy.status().running;
    if (was) {
      await s.comfy.stop().catch(() => undefined);
      void s.comfy.start().catch(() => undefined);
    }
    return { ok: true, chat: s.config.engines.gpus.use ?? null, comfy: s.config.comfyui.gpu ?? null, restartedComfy: was };
  });

  /** What the image engine is doing (phase, step x of y, seconds per step), or `{}` when idle. */
  app.get("/api/engines/image/progress", async () => s.sd.progress() ?? {});

  /** The image engine's last run: the full console output, for troubleshooting slow or failed images. */
  app.get("/api/engines/image/log", async (_req, reply) => {
    const text = await readFile(s.sd.logFile, "utf8").catch(() => "");
    return reply.type("text/plain; charset=utf-8").send(text || "The image engine has not run yet.");
  });

  // On Linux, an engine installed for the processor alone is replaced once a graphics card can be used (AMD and
  // Intel were not detected before 0.6.126). A little after start, so the server answers first.
  if (process.platform === "linux") {
    const t = setTimeout(() => s.engine.status().installed && void ensureEngine(s).catch(() => undefined), 20_000);
    t.unref?.();
  }

  /** Starts installing in the background; poll GET /api/engines/llamacpp for progress. */
  app.post("/api/engines/llamacpp/install", async () => {
    void ensureEngine(s).catch((err) => s.engine.fail(err));
    return s.engine.status();
  });

  app.post<{ Body: { modelPath: string; name?: string } }>("/api/engines/llamacpp/load", async (req, reply) => {
    const path = req.body?.modelPath ?? "";
    if (!allowedModelPath(s, path)) return reply.code(400).send({ error: "Only models in KesherAI's models folder or a folder you added can be loaded" });
    if (!(await looksLikeGguf(path))) return reply.code(400).send({ error: "llama.cpp loads GGUF files" });
    try {
      const modelId = await loadModel(s, path, req.body.name, { kind: "chosen" });
      return { ...s.engine.status(), modelId };
    } catch (err) {
      return reply.code(500).send({ error: (err as Error).message });
    }
  });

  /**
   * Measures how fast a model writes on this computer: loads it, writes about
   * 200 tokens to a fixed request, and keeps the speed (shown next to the
   * model instead of the estimate). Body: `{ modelPath }`.
   */
  app.post<{ Body: { modelPath?: string } }>("/api/models/benchmark", async (req, reply) => {
    const path = req.body?.modelPath ?? "";
    if (!allowedModelPath(s, path)) return reply.code(400).send({ error: "Only models in KesherAI's models folder or a folder you added can be measured" });
    if (!(await looksLikeGguf(path))) return reply.code(400).send({ error: "Speed tests run on GGUF files" });
    if (engineBusy(s)) return reply.code(409).send({ error: "The engine is busy. Wait for the current step to finish." });
    try {
      if (s.engine.status().modelPath !== path || !s.engine.status().running) await loadModel(s, path, undefined, { kind: "benchmark" });
      const body = { prompt: "Write a short story about a lighthouse keeper, in plain English.", n_predict: 200, temperature: 0.7, cache_prompt: false };
      const res = await fetch(`${s.engine.baseUrl.replace(/\/v1$/, "")}/completion`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${s.engine.apiKey}` }, body: JSON.stringify(body), signal: AbortSignal.timeout(300_000) });
      if (!res.ok) throw new Error(`The engine answered ${res.status}`);
      const j = (await res.json()) as { timings?: { predicted_n?: number; predicted_ms?: number; predicted_per_second?: number; prompt_per_second?: number } };
      const n = j.timings?.predicted_n ?? 0;
      const ms = j.timings?.predicted_ms ?? 0;
      if (!n || !ms) throw new Error("The engine did not report its speed.");
      await s.speeds.record(basename(path), n, ms);
      // Then the fixed questions (audit F11): how many it gets right, at temperature 0, thinking off.
      let right = 0;
      for (const q of BENCH_SET) {
        const r = await fetch(`${s.engine.baseUrl}/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${s.engine.apiKey}` },
          body: JSON.stringify({ messages: [{ role: "system", content: BENCH_SYSTEM }, { role: "user", content: q.q }], temperature: 0, max_tokens: 96, cache_prompt: false, chat_template_kwargs: { enable_thinking: false } }),
          signal: AbortSignal.timeout(120_000),
        }).catch(() => null);
        const a = r?.ok ? ((await r.json()) as { choices?: Array<{ message?: { content?: string } }> }).choices?.[0]?.message?.content ?? "" : "";
        if (benchRight(a, q)) right++;
      }
      return { tps: Math.round((n / (ms / 1000)) * 10) / 10, promptTps: Math.round(j.timings?.prompt_per_second ?? 0), tokens: n, right, of: BENCH_SET.length };
    } catch (err) {
      return reply.code(500).send({ error: (err as Error).message });
    }
  });

  /**
   * How many chats the engine answers at once, and multi-token prediction's guesses ahead (`mtpDraft`: a number,
   * 0 for off, null for llama.cpp's own). A running model is loaded again with them.
   */
  app.put<{ Body: { parallel?: number; mtpDraft?: number | null; lookup?: boolean | null; ramCache?: boolean | null; fitTargetMiB?: number | null; kvType?: "f16" | "q8_0" | "q4_0" | null } }>("/api/engines/llamacpp/settings", async (req, reply) => {
    const b = req.body ?? {};
    let reload = false;
    if (b.parallel !== undefined) {
      const n = Number(b.parallel);
      if (!Number.isInteger(n) || n < 1 || n > 8) return reply.code(400).send({ error: "Chats at once: a number from 1 to 8." });
      reload ||= s.config.engines.parallel !== n;
      s.config.engines.parallel = n;
      s.engine.setParallel(n);
    }
    if (b.mtpDraft !== undefined) {
      const d = b.mtpDraft === null ? undefined : Number(b.mtpDraft);
      if (d !== undefined && (!Number.isInteger(d) || d < 0 || d > 16)) return reply.code(400).send({ error: "Guesses ahead: a number from 0 to 16." });
      reload ||= s.config.engines.mtpDraft !== d;
      if (d === undefined) delete s.config.engines.mtpDraft;
      else s.config.engines.mtpDraft = d;
      s.engine.setMtpDraft(d);
    }
    // "Speed up with lookup decoding": true/false, null for the default (on).
    if (b.lookup !== undefined) {
      if (b.lookup !== null && typeof b.lookup !== "boolean") return reply.code(400).send({ error: "Lookup decoding: on or off." });
      const on = b.lookup ?? undefined;
      reload ||= s.config.engines.lookup !== on;
      if (on === undefined) delete s.config.engines.lookup;
      else s.config.engines.lookup = on;
      s.engine.setLookup(on);
    }
    // "Keep chats' prompts in RAM" (llama.cpp's host-RAM prompt cache): true/false, null for the default (on).
    if (b.ramCache !== undefined) {
      if (b.ramCache !== null && typeof b.ramCache !== "boolean") return reply.code(400).send({ error: "RAM prompt cache: on or off." });
      const on = b.ramCache ?? undefined;
      reload ||= s.config.engines.ramCache !== on;
      if (on === undefined) delete s.config.engines.ramCache;
      else s.config.engines.ramCache = on;
      s.engine.setRamCache(on);
    }
    // Graphics memory to leave free (for a game or the Unreal/Unity editor on the same card); null: the default.
    if (b.fitTargetMiB !== undefined) {
      const m = b.fitTargetMiB === null ? undefined : Number(b.fitTargetMiB);
      if (m !== undefined && (!Number.isInteger(m) || m < 512 || m > 16384)) return reply.code(400).send({ error: "Memory to leave free: 512 to 16384 MB." });
      reload ||= s.config.engines.fitTargetMiB !== m;
      if (m === undefined) delete s.config.engines.fitTargetMiB;
      else s.config.engines.fitTargetMiB = m;
      s.engine.setFitTarget(m);
    }
    // The context memory's type (calibration's "Use this", or by hand); null: the default (8 bits).
    if (b.kvType !== undefined) {
      if (b.kvType !== null && b.kvType !== "f16" && b.kvType !== "q8_0" && b.kvType !== "q4_0") return reply.code(400).send({ error: "Context memory: f16, q8_0 or q4_0." });
      const k = b.kvType ?? undefined;
      reload ||= s.config.engines.kvType !== k;
      if (k === undefined) delete s.config.engines.kvType;
      else s.config.engines.kvType = k;
      s.engine.setKvType(k);
    }
    await s.saveConfig();
    const st = s.engine.status();
    if (reload && st.running && st.modelPath) void loadModel(s, st.modelPath, undefined, { kind: "settings" }).catch((err) => s.engine.fail(err));
    return { ...s.engine.status(), mtpDraft: s.config.engines.mtpDraft ?? null, fitTargetMiB: s.config.engines.fitTargetMiB ?? 2048, kvType: s.config.engines.kvType ?? "q8_0" };
  });

  /**
   * A model's own load settings (Models → ⚙, as LM Studio keeps them per model): read, and save. Saved by the file's
   * name and used at each load of it; `reload` loads it again now when it is the running model. Empty settings remove
   * the entry (back to the engine's own).
   */
  app.get<{ Querystring: { path?: string } }>("/api/models/load-settings", async (req, reply) => {
    const path = req.query.path ?? "";
    if (!allowedModelPath(s, path)) return reply.code(400).send({ error: "Only models in KesherAI's models folder or a folder you added" });
    return { settings: s.config.engines.modelSettings[basename(path)] ?? {} };
  });
  app.put<{ Body: { path?: string; settings?: ModelLoadSettings; reload?: boolean } }>("/api/models/load-settings", async (req, reply) => {
    const path = req.body?.path ?? "";
    if (!allowedModelPath(s, path)) return reply.code(400).send({ error: "Only models in KesherAI's models folder or a folder you added" });
    const raw = req.body?.settings ?? {};
    const settings: ModelLoadSettings = {
      ...(raw.ctx !== undefined && raw.ctx !== null ? { ctx: Number(raw.ctx) } : {}),
      ...(raw.kv ? { kv: raw.kv } : {}),
      ...(raw.cpuMoe !== undefined && raw.cpuMoe !== null ? { cpuMoe: Number(raw.cpuMoe) } : {}),
      ...(raw.flash ? { flash: raw.flash } : {}),
      ...(Array.isArray(raw.extra) && raw.extra.length ? { extra: raw.extra.map(String) } : {}),
    };
    const wrong = checkLoadSettings(settings);
    if (wrong) return reply.code(400).send({ error: wrong });
    const name = basename(path);
    if (Object.keys(settings).length) s.config.engines.modelSettings[name] = settings;
    else delete s.config.engines.modelSettings[name];
    await s.saveConfig();
    const st = s.engine.status();
    const reloading = !!req.body?.reload && st.running && st.modelPath === path;
    if (reloading) void loadModel(s, path, undefined, { kind: "settings" }).catch((err) => s.engine.fail(err));
    return { settings, reloading };
  });

  /**
   * Calibrate a model to this computer (calibrate.ts): llama-bench with the context memory at 8 and at 16 bits,
   * at 0, 16K and 48K tokens deep, with the chat model unloaded for the run (about 5 minutes), then loaded back.
   * One run at a time; refused while a chat or self-work is answering. The result is kept per model and card.
   */
  let cal: { model: string; status: "running" | "done" | "failed" | "stopped"; step: number; steps: number; rows: CalRow[]; advice?: CalAdvice; error?: string; startedAt: string; ctrl?: AbortController } | undefined;
  const calView = () => (cal ? { model: cal.model, status: cal.status, step: cal.step, steps: cal.steps, rows: cal.rows, ...(cal.advice ? { advice: cal.advice } : {}), ...(cal.error ? { error: cal.error } : {}), startedAt: cal.startedAt } : null);
  app.get("/api/models/calibrate", async () => ({ run: calView(), kvType: s.config.engines.kvType ?? "q8_0", saved: s.config.engines.calibrations }));
  app.post<{ Body: { modelPath?: string } }>("/api/models/calibrate", async (req, reply) => {
    const path = req.body?.modelPath ?? "";
    if (!allowedModelPath(s, path)) return reply.code(400).send({ error: "Only models in KesherAI's models folder or a folder you added can be calibrated" });
    if (!(await looksLikeGguf(path))) return reply.code(400).send({ error: "Calibration runs on GGUF files" });
    if (cal?.status === "running") return reply.code(409).send({ error: "A calibration is already running." });
    if (engineBusy(s) || Object.values(s.conversations.activity()).includes("running")) return reply.code(409).send({ error: "A chat or self-work is answering now. Calibrate when it is quiet (it needs the whole graphics card for about 5 minutes)." });
    const before = s.engine.status().running ? s.engine.status().modelPath : undefined;
    const ctrl = new AbortController();
    cal = { model: basename(path), status: "running", step: 0, steps: 2, rows: [], startedAt: new Date().toISOString(), ctrl };
    const run = cal;
    void (async () => {
      try {
        await s.engine.stop();
        let gpu = "";
        for (const kv of ["q8_0", "f16"] as const) {
          s.guard.touch("llamacpp");
          // 48K deep may not fit with 16-bit context on a smaller card: then the shallower depths only.
          const out = await s.engine.bench(path, kv, [0, 16384, 49152], ctrl.signal).catch((e: Error) => (ctrl.signal.aborted ? Promise.reject(e) : s.engine.bench(path, kv, [0, 16384], ctrl.signal)));
          gpu ||= /"gpu_info":\s*"([^"]*)"/.exec(out)?.[1] ?? "";
          run.rows.push(...parseBench(out));
          run.step++;
        }
        run.advice = advise(run.rows);
        run.status = "done";
        s.config.engines.calibrations[run.model] = { at: new Date().toISOString(), gpu, rows: run.rows, kv: run.advice.kv };
        await s.saveConfig();
      } catch (e) {
        run.status = ctrl.signal.aborted ? "stopped" : "failed";
        run.error = (e as Error).message;
      } finally {
        delete run.ctrl;
        if (before) await loadModel(s, before, undefined, { kind: "calibration" }).catch((err) => s.engine.fail(err));
      }
    })();
    return { run: calView() };
  });
  app.post("/api/models/calibrate/stop", async () => {
    cal?.ctrl?.abort();
    return { run: calView() };
  });

  /**
   * What llama.cpp will do with a model before it is loaded (llama-fit-params): layers on each graphics card,
   * memory used and left, context, and whether it fits next to what is loaded now. Kept a minute per model.
   */
  const fitCache = new Map<string, { at: number; plan: unknown }>();
  app.post<{ Body: { modelPath?: string } }>("/api/models/fit", async (req, reply) => {
    const path = req.body?.modelPath ?? "";
    if (!allowedModelPath(s, path)) return reply.code(400).send({ error: "Only models in KesherAI's models folder or a folder you added can be checked" });
    if (!(await looksLikeGguf(path))) return reply.code(400).send({ error: "The memory check runs on GGUF files" });
    const hit = fitCache.get(path);
    if (hit && Date.now() - hit.at < 60_000) return hit.plan;
    try {
      // Free system memory now (Windows counts standby cache as available), for the plan's "Host" part.
      const plan = { ...(await s.engine.fitPreview(path)), ramFreeMiB: Math.round(freemem() / 1024 ** 2), ramTotalMiB: Math.round(totalmem() / 1024 ** 2), loadedNow: s.engine.status().running ? basename(s.engine.status().modelPath ?? "") : null, marginMiB: s.config.engines.fitTargetMiB ?? 2048 };
      fitCache.set(path, { at: Date.now(), plan });
      return plan;
    } catch (err) {
      return reply.code(500).send({ error: (err as Error).message });
    }
  });

  app.post("/api/engines/llamacpp/stop", async () => {
    await s.engine.stop();
    // Stopped by hand: it stays stopped after a restart too (a request still loads it when it needs it).
    s.config.engines.lastUnloaded = true;
    await s.saveConfig();
    return s.engine.status();
  });

  /** Is there a newer llama.cpp? (It updates without a KesherAI update.) */
  app.get("/api/engines/llamacpp/update", async (_req, reply) => {
    try {
      const rel = await findLlamaRelease(AbortSignal.timeout(15_000));
      const installed = s.config.engines.llamaVersion ?? null;
      const num = (v: string | null) => Number(/b(\d+)/.exec(v ?? "")?.[1] ?? 0);
      return { installed, latest: rel.tag_name, newer: !!installed && num(rel.tag_name) > num(installed) };
    } catch (e) {
      return reply.code(502).send({ error: (e as Error).message });
    }
  });

  /** Updates llama.cpp to the newest build and loads the model again (the user presses the button). */
  app.post("/api/engines/llamacpp/update", async (_req, reply) => {
    if (engineBusy(s)) return reply.code(409).send({ error: "The engine is busy. Wait for the current step to finish." });
    void (async () => {
      const running = s.engine.status();
      const hw = await detectHardware();
      const { binaryPath, version, build } = await s.engine.install(s.downloads, enginePlatform(hw));
      s.config.engines.llamaServerPath = binaryPath;
      s.config.engines.llamaVersion = version;
      if (build) s.config.engines.llamaBuild = build;
      await s.saveConfig();
      if (running.running && running.modelPath) await loadModel(s, running.modelPath, undefined, { kind: "update" });
    })().catch((err) => s.engine.fail(err));
    return reply.code(202).send(s.engine.status());
  });

  /** "Skip for now" during "Set it up for me": skips the model being downloaded and goes on. */
  app.post("/api/models/setup/skip", async (_req, reply) => (skipSetupDownload(s) ? s.engine.status() : reply.code(409).send({ error: "Nothing is downloading for setup." })));

  /** The "Start here" list, with whether each model is already downloaded. */
  app.get("/api/models/recommended", async () => {
    const hw = await detectHardwareCached();
    const onComputer = await modelsOnComputer(s);
    return RECOMMENDED_MODELS.map((m) => {
      // Downloaded = the model file itself is on this computer (not just its folder, which a stopped download leaves).
      const copy = matchRecommended(onComputer, m.repo, m.filePattern);
      return {
      ...m,
      downloaded: !!copy,
      ...(copy ? { foundIn: copy.source } : {}),
      estimate: estimatePerformance(m.sizeGb * 1024 ** 3, hw, { ...(m.activeFraction ? { activeFraction: m.activeFraction } : {}) }),
      };
    });
  });

  /**
   * One click: install the engine if needed, download the model if needed,
   * load it. Runs in the background; progress is in GET /api/engines/llamacpp
   * and the download list.
   */
  app.post<{ Params: { id: string } }>("/api/models/recommended/:id/run", async (req, reply) => {
    const model = RECOMMENDED_MODELS.find((m) => m.id === req.params.id);
    if (!model) return reply.code(404).send({ error: "Unknown model" });
    if (engineBusy(s)) return reply.code(409).send({ error: "The engine is busy. Wait for the current step to finish." });
    void setUp(s, [model]).catch((err) => s.engine.fail(err));
    return reply.code(202).send(s.engine.status());
  });

  /**
   * Every kind of model KesherAI runs on this computer besides chat and
   * pictures, for the Models page: is it ready, is it downloading, how big
   * is it, and where its "Set it up" button posts.
   */
  app.get("/api/models/kinds", async () => {
    const video = await videoStatus({ sd: s.sd, config: s.config, modelsDir: () => s.paths.models });
    const stt = await s.whisper.status();
    const tts = s.kokoro.status();
    const emb = s.semantic.status();
    return {
      video: { ready: video.ready, busy: video.downloading, ...(video.model ? { model: video.model } : {}), name: RECOMMENDED_VIDEO_MODEL.name, sizeGb: 7.2, setup: "/api/models/setup/media/video", active: s.config.activeModels.video ?? null, comfy: comfyWanStatus(s.paths.models) },
      "speech-to-text": { ready: stt.engine && !!stt.model, busy: !!stt.busy, ...(stt.error ? { error: stt.error } : {}), ...(stt.model ? { model: stt.model.split(/[\\/]/).pop() } : {}), name: `whisper.cpp · ${stt.recommended.label}`, sizeGb: stt.recommended.sizeGb, setup: stt.localPossible ? "/api/speech/stt/setup" : null },
      "text-to-speech": { ready: tts.ready, busy: tts.busy, name: "Kokoro", sizeGb: tts.sizeMb / 1024, setup: "/api/speech/tts/local/setup", voices: tts.voices },
      embedding: { ready: emb.usable, busy: emb.phase === "downloading" || emb.phase === "loading", ...(emb.phase === "error" && emb.message ? { error: emb.message } : {}), ...(emb.active ? { model: emb.active.split("/").pop() } : {}), name: emb.model.name, sizeGb: emb.model.sizeGb, setup: "/api/knowledge/semantic/setup" },
    };
  });

  /** Downloads what ComfyUI needs for Wan 2.1 video (the model is shared with the built-in engine). */
  app.post("/api/models/setup/comfy-video", async (_req, reply) => {
    try {
      return { started: await setupComfyWan({ downloads: s.downloads, modelsDir: () => s.paths.models }), ...comfyWanStatus(s.paths.models) };
    } catch (err) {
      return reply.code(502).send({ error: (err as Error).message });
    }
  });

  /**
   * "Set it up for me" for pictures and video: picks the model that fits this
   * computer (images: Qwen-Image or Flux; video: Wan 2.1), downloads it with
   * its extra files in the background, and makes it the active one.
   * Returns `{ ready }` or `{ message }` (what is downloading).
   */
  app.post<{ Params: { kind: string } }>("/api/models/setup/media/:kind", async (req, reply) => {
    const d = { sd: s.sd, downloads: s.downloads, config: s.config, modelsDir: () => s.paths.models, save: () => s.saveConfig() };
    try {
      if (req.params.kind === "image") {
        const r = await ensureImageModel(d);
        return r.modelId ? { ready: true, model: r.modelId } : { ready: false, message: r.message };
      }
      if (req.params.kind === "video") {
        const r = await ensureVideoModel(d);
        return r.path ? { ready: true, model: r.path } : { ready: false, message: r.message };
      }
      return reply.code(400).send({ error: "image or video" });
    } catch (err) {
      return reply.code(502).send({ error: (err as Error).message });
    }
  });

  /**
   * "Set it up for me": installs the engine, downloads every selected model
   * one after another, and loads the first one. Body: `{ ids: string[] }`.
   */
  app.post<{ Body: { ids?: string[] } }>("/api/models/setup", async (req, reply) => {
    const ids = req.body?.ids ?? [];
    const models = ids.map((id) => RECOMMENDED_MODELS.find((m) => m.id === id));
    if (!models.length || models.some((m) => !m)) return reply.code(400).send({ error: "Choose at least one known model" });
    if (engineBusy(s)) return reply.code(409).send({ error: "The engine is busy. Wait for the current step to finish." });
    void setUp(s, models as RecommendedModel[]).catch((err) => s.engine.fail(err));
    return reply.code(202).send(s.engine.status());
  });
}

/**
 * Skips the model "Set it up for me" is downloading now.
 *
 * @param s - Services.
 * @returns Whether there was one.
 */
export function skipSetupDownload(s: KesherServices): boolean {
  if (!setupJob) return false;
  setupJob.skipped = true;
  return s.downloads.cancel(setupJob.id);
}

function engineBusy(s: KesherServices): boolean {
  const job = s.engine.status().job;
  return !!job && job.phase !== "error";
}

/** The setup download running now, so "Skip for now" can skip it. */
let setupJob: { id: string; skipped: boolean } | undefined;

/** Installs the engine, downloads each model if missing (skipping any the user skips), and loads the first one there is. */
async function setUp(s: KesherServices, models: RecommendedModel[]): Promise<void> {
  await ensureEngine(s);
  const paths: string[] = [];
  for (const model of models) {
    try {
      const files = await s.engine.track("downloading-model", `Finding ${model.name}…`, () =>
        listHubFiles(model.repo, { ...(s.config.huggingFaceToken ? { token: s.config.huggingFaceToken } : {}) }),
      );
      const file = files.find((f) => new RegExp(model.filePattern, "i").test(f.path));
      if (!file) throw new Error(`No file matching ${model.filePattern} in ${model.repo}`);
      let dest = join(s.paths.models, "chat", model.repo, file.path);
      // Already on this computer (here or in another app's folder, like LM Studio): use it in place, no second download.
      const copy = existsSync(dest) ? undefined : matchRecommended(await modelsOnComputer(s, true), model.repo, model.filePattern);
      if (copy) dest = copy.path;
      if (!existsSync(dest)) {
        await s.engine.track("downloading-model", `Downloading ${model.name} (${model.sizeGb} GB)…`, async () => {
          const job = s.downloads.enqueue({
            url: file.url,
            dest,
            size: file.size,
            ...(file.sha256 ? { sha256: file.sha256 } : {}),
            label: `${model.name} · ${file.path}`,
          });
          setupJob = { id: job.id, skipped: false };
          await waitForDownload(s.downloads, job.id);
          found = undefined;
        });
      }
      paths.push(dest);
    } catch (err) {
      // "Skip for now": go on with the next model; the skipped one can be downloaded later.
      if (!setupJob?.skipped) throw err;
    } finally {
      setupJob = undefined;
    }
  }
  if (!paths.length) {
    s.engine.fail(new Error("Setup skipped. You can download a model any time from this page."));
    return;
  }
  await loadModel(s, paths[0]!, undefined, { kind: "setup" });
}

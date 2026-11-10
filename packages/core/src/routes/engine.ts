import { readFile } from "node:fs/promises";
import type { FastifyInstance } from "fastify";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { RECOMMENDED_MODELS, type RecommendedModel } from "@kesher/shared";
import { detectHardware, detectHardwareCached, estimatePerformance, listHubFiles } from "@kesher/downloads";
import type { KesherServices } from "../services.js";
import { findLlamaRelease, waitForDownload } from "../llamacpp.js";
import { insideAny, looksLikeGguf, matchRecommended, scanComputer, scanFolder, type FoundModel } from "../model-scan.js";
import { bySpeed, planGpus, type Gpu } from "../gpus.js";
import { RECOMMENDED_VIDEO_MODEL, comfyWanStatus, ensureImageModel, ensureVideoModel, setupComfyWan, videoStatus } from "../sdcpp.js";

/**
 * Installs the llama.cpp engine if it is missing. Shared by the install
 * route and the one-click "run this model" route.
 *
 * @param s - Services.
 */
export async function ensureEngine(s: KesherServices): Promise<void> {
  if (s.engine.status().installed) return;
  const hw = await detectHardware();
  const { binaryPath, version } = await s.engine.install(s.downloads, {
    platform: process.platform,
    arch: process.arch,
    nvidia: hw.gpus.length > 0,
  });
  s.config.engines.llamaServerPath = binaryPath;
  s.config.engines.llamaVersion = version;
  await s.saveConfig();
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

/**
 * Loads a GGUF file in the engine, registers the `llamacpp` provider,
 * remembers it for the next start, and makes it the active chat model if
 * none is set.
 *
 * @param s - Services.
 * @param modelPath - Absolute path inside the models folder.
 * @returns The model id, e.g. `llamacpp/Qwen3-8B-Q4_K_M`.
 */
export async function loadModel(s: KesherServices, modelPath: string, name?: string): Promise<string> {
  await s.engine.load(modelPath);
  // A model just loaded is in use: without this, the idle unloader (20 minutes by default) stopped it seconds after
  // loading when nothing had run for a while (found on the PC: Qwen3.6 loaded, then unloaded 3 s later).
  s.guard.touch("llamacpp");
  s.registerEngineProvider();
  const modelId = `llamacpp/${(name ?? basename(modelPath)).replace(/\.gguf$/i, "").replace(/[\s/]+/g, "-")}`;
  s.config.engines.lastModel = modelPath;
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
  app.get("/api/engines/llamacpp", async () => s.engine.status());

  /**
   * The graphics cards and how models use them: each card (PCI order, memory,
   * compute capability, fastest first marked), the user's choice, and what
   * that choice does for a model of a given size (`?modelGb=`).
   */
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
    return { gpus: gpus.map((g) => ({ ...g, fastest: g.index === fastest })), prefs: s.config.engines.gpus, examples, current: s.engine.status().gpus ?? null };
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

  /** What the image engine is doing (phase, step x of y, seconds per step), or `{}` when idle. */
  app.get("/api/engines/image/progress", async () => s.sd.progress() ?? {});

  /** The image engine's last run: the full console output, for troubleshooting slow or failed images. */
  app.get("/api/engines/image/log", async (_req, reply) => {
    const text = await readFile(s.sd.logFile, "utf8").catch(() => "");
    return reply.type("text/plain; charset=utf-8").send(text || "The image engine has not run yet.");
  });

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
      const modelId = await loadModel(s, path, req.body.name);
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
      if (s.engine.status().modelPath !== path || !s.engine.status().running) await loadModel(s, path);
      const body = { prompt: "Write a short story about a lighthouse keeper, in plain English.", n_predict: 200, temperature: 0.7, cache_prompt: false };
      const res = await fetch(`${s.engine.baseUrl.replace(/\/v1$/, "")}/completion`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(300_000) });
      if (!res.ok) throw new Error(`The engine answered ${res.status}`);
      const j = (await res.json()) as { timings?: { predicted_n?: number; predicted_ms?: number; predicted_per_second?: number; prompt_per_second?: number } };
      const n = j.timings?.predicted_n ?? 0;
      const ms = j.timings?.predicted_ms ?? 0;
      if (!n || !ms) throw new Error("The engine did not report its speed.");
      await s.speeds.record(basename(path), n, ms);
      return { tps: Math.round((n / (ms / 1000)) * 10) / 10, promptTps: Math.round(j.timings?.prompt_per_second ?? 0), tokens: n };
    } catch (err) {
      return reply.code(500).send({ error: (err as Error).message });
    }
  });

  /**
   * How many chats the engine answers at once, and multi-token prediction's guesses ahead (`mtpDraft`: a number,
   * 0 for off, null for llama.cpp's own). A running model is loaded again with them.
   */
  app.put<{ Body: { parallel?: number; mtpDraft?: number | null } }>("/api/engines/llamacpp/settings", async (req, reply) => {
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
    await s.saveConfig();
    const st = s.engine.status();
    if (reload && st.running && st.modelPath) void loadModel(s, st.modelPath).catch((err) => s.engine.fail(err));
    return { ...s.engine.status(), mtpDraft: s.config.engines.mtpDraft ?? null };
  });

  app.post("/api/engines/llamacpp/stop", async () => {
    await s.engine.stop();
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
      const { binaryPath, version } = await s.engine.install(s.downloads, { platform: process.platform, arch: process.arch, nvidia: hw.gpus.length > 0 });
      s.config.engines.llamaServerPath = binaryPath;
      s.config.engines.llamaVersion = version;
      await s.saveConfig();
      if (running.running && running.modelPath) await loadModel(s, running.modelPath);
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
  await loadModel(s, paths[0]!);
}

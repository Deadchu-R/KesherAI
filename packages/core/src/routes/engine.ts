import { readFile } from "node:fs/promises";
import type { FastifyInstance } from "fastify";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { RECOMMENDED_MODELS, type RecommendedModel } from "@kesher/shared";
import { detectHardware, detectHardwareCached, estimatePerformance, listHubFiles } from "@kesher/downloads";
import type { KesherServices } from "../services.js";
import { waitForDownload } from "../llamacpp.js";
import { insideAny, looksLikeGguf } from "../model-scan.js";

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

  app.post("/api/engines/llamacpp/stop", async () => {
    await s.engine.stop();
    return s.engine.status();
  });

  /** The "Start here" list, with whether each model is already downloaded. */
  app.get("/api/models/recommended", async () => {
    const hw = await detectHardwareCached();
    return RECOMMENDED_MODELS.map((m) => ({
      ...m,
      downloaded: existsSync(join(s.paths.models, "chat", m.repo)),
      estimate: estimatePerformance(m.sizeGb * 1024 ** 3, hw, { ...(m.activeFraction ? { activeFraction: m.activeFraction } : {}) }),
    }));
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

function engineBusy(s: KesherServices): boolean {
  const job = s.engine.status().job;
  return !!job && job.phase !== "error";
}

/** Installs the engine, downloads each model if missing, and loads the first. */
async function setUp(s: KesherServices, models: RecommendedModel[]): Promise<void> {
  await ensureEngine(s);
  const paths: string[] = [];
  for (const model of models) {
    const files = await s.engine.track("downloading-model", `Finding ${model.name}…`, () =>
      listHubFiles(model.repo, { ...(s.config.huggingFaceToken ? { token: s.config.huggingFaceToken } : {}) }),
    );
    const file = files.find((f) => new RegExp(model.filePattern, "i").test(f.path));
    if (!file) throw new Error(`No file matching ${model.filePattern} in ${model.repo}`);
    const dest = join(s.paths.models, "chat", model.repo, file.path);
    if (!existsSync(dest)) {
      await s.engine.track("downloading-model", `Downloading ${model.name} (${model.sizeGb} GB)…`, async () => {
        const job = s.downloads.enqueue({
          url: file.url,
          dest,
          size: file.size,
          ...(file.sha256 ? { sha256: file.sha256 } : {}),
          label: `${model.name} · ${file.path}`,
        });
        await waitForDownload(s.downloads, job.id);
      });
    }
    paths.push(dest);
  }
  await loadModel(s, paths[0]!);
}

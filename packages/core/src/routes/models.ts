import type { FastifyInstance } from "fastify";
import { mkdir, readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { PROVIDER_PRESETS, type ProviderConfig } from "@kesher/providers";
import { detectHardwareCached, estimatePerformance } from "@kesher/downloads";
import type { KesherServices } from "../services.js";
import { scanComputer, scanFolder } from "../model-scan.js";
import { isLoopback } from "../auth.js";
import { assertWritableFolder } from "../library.js";
import { engineRoutes } from "./engine.js";

function mask(config: ProviderConfig): ProviderConfig & { hasApiKey: boolean } {
  const { apiKey, ...rest } = config;
  return { ...rest, hasApiKey: !!apiKey };
}

async function listFilesRecursive(dir: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await listFilesRecursive(full)));
    else if (!e.name.endsWith(".part")) out.push(full);
  }
  return out;
}

/**
 * Models, providers (connections) and local model files.
 *
 * @param app - Fastify instance.
 * @param s - Services.
 */
export async function modelRoutes(app: FastifyInstance, s: KesherServices): Promise<void> {
  /** Every model from every provider, plus providers that failed to answer. */
  app.get("/api/models", async () => s.registry.listAllModels());

  /**
   * Model files KesherAI can use: those it downloaded, plus those in the
   * folders the user added (LM Studio, Ollama, …). Each has a `source` and,
   * for GGUF, whether the built-in engine can load it.
   */
  app.get("/api/models/local", async () => {
    const [files, hw, extra] = await Promise.all([
      listFilesRecursive(s.paths.models),
      detectHardwareCached(),
      Promise.all(s.config.modelFolders.map((f) => scanFolder(f))),
    ]);
    const own = await Promise.all(
      files.map(async (path) => {
        const size = (await stat(path)).size;
        return { path, name: relative(s.paths.models, path), size, source: "KesherAI", gguf: path.toLowerCase().endsWith(".gguf"), estimate: estimatePerformance(size, hw) };
      }),
    );
    const others = extra.flat().map((m) => ({ path: m.path, name: m.name, size: m.size, source: m.source, gguf: m.format === "gguf", estimate: estimatePerformance(m.size, hw) }));
    return [...own, ...others];
  });

  /** The download folder and the extra folders KesherAI reads models from. */
  app.get("/api/models/folders", async () => ({
    modelsDir: s.paths.models,
    defaultDir: join(s.paths.root, "models"),
    folders: s.config.modelFolders,
  }));

  /**
   * Changes the download folder and/or the extra folders. Only from this
   * computer. Body: `{ modelsDir?: string | null, folders?: { folder, source }[] }`.
   */
  app.put<{ Body: { modelsDir?: string | null; folders?: Array<{ folder: string; source?: string }> } }>("/api/models/folders", async (req, reply) => {
    if (!isLoopback(req.ip)) return reply.code(403).send({ error: "Model folders can only be changed on this computer." });
    const b = req.body ?? {};
    try {
      if (b.modelsDir !== undefined) {
        if (b.modelsDir) {
          await mkdir(b.modelsDir, { recursive: true });
          await assertWritableFolder(b.modelsDir);
          s.config.modelsDir = b.modelsDir;
          s.paths.models = b.modelsDir;
        } else {
          delete s.config.modelsDir;
          s.paths.models = join(s.paths.root, "models");
        }
      }
      if (b.folders) {
        const list: Array<{ folder: string; source: string }> = [];
        for (const f of b.folders) {
          if (!(await stat(f.folder).catch(() => undefined))?.isDirectory()) throw new Error(`Not a folder: ${f.folder}`);
          if (!list.some((x) => x.folder === f.folder)) list.push({ folder: f.folder, source: f.source || "Folder" });
        }
        s.config.modelFolders = list;
      }
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
    await s.saveConfig();
    return { modelsDir: s.paths.models, defaultDir: join(s.paths.root, "models"), folders: s.config.modelFolders };
  });

  /**
   * Looks for models other apps already downloaded (LM Studio, Ollama,
   * Hugging Face cache, Jan, GPT4All, ComfyUI) and in the added folders.
   * Read-only: nothing is added until the user saves the folders.
   */
  app.post("/api/models/scan", async (req, reply) => {
    if (!isLoopback(req.ip)) return reply.code(403).send({ error: "Scanning runs only on this computer." });
    const hw = await detectHardwareCached();
    const results = await scanComputer(s.config.modelFolders);
    return results.map((r) => ({
      folder: r.folder,
      source: r.source,
      added: s.config.modelFolders.some((f) => f.folder === r.folder),
      totalSize: r.models.reduce((n, m) => n + m.size, 0),
      models: r.models.map((m) => ({ ...m, estimate: estimatePerformance(m.size, hw) })),
    }));
  });

  app.get("/api/providers", async () =>
    Promise.all(
      s.registry.list().map(async ({ provider, config }) => ({
        ...mask(config),
        capabilities: provider.capabilities,
        autodetected: s.autodetected.has(config.id),
        healthy: await provider.checkHealth(AbortSignal.timeout(2500)),
      })),
    ),
  );

  app.get("/api/providers/presets", async () => PROVIDER_PRESETS);

  app.get("/api/providers/types", async () =>
    s.registry.listFactories().map(({ type, displayName, categories }) => ({ type, displayName, categories })),
  );

  /** Adds or replaces a provider and saves it to the config file. */
  app.post<{ Body: ProviderConfig }>("/api/providers", async (req, reply) => {
    const config = req.body;
    try {
      s.registry.add(config);
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
    s.autodetected.delete(config.id);
    s.config.providers = [...s.config.providers.filter((p) => p.id !== config.id), config];
    await s.saveConfig();
    return mask(config);
  });

  app.delete<{ Params: { id: string } }>("/api/providers/:id", async (req) => {
    s.registry.remove(req.params.id);
    s.config.providers = s.config.providers.filter((p) => p.id !== req.params.id);
    await s.saveConfig();
    return { ok: true };
  });

  await engineRoutes(app, s);
}

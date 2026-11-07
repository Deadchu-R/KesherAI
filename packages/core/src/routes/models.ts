import type { FastifyInstance } from "fastify";
import { readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { PROVIDER_PRESETS, type ProviderConfig } from "@kesher/providers";
import type { KesherServices } from "../services.js";

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

  /** Model files downloaded into the data folder (e.g. GGUF files to load in llama.cpp). */
  app.get("/api/models/local", async () => {
    const files = await listFilesRecursive(s.paths.models);
    return Promise.all(
      files.map(async (path) => ({ path, name: relative(s.paths.models, path), size: (await stat(path)).size })),
    );
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

  /** Managed llama.cpp: load a downloaded GGUF and chat with it as provider `llamacpp`. */
  app.get("/api/engines/llamacpp", async () => s.llama?.status() ?? { running: false, configured: false, log: [] });

  app.post<{ Body: { modelPath: string } }>("/api/engines/llamacpp/load", async (req, reply) => {
    if (!s.llama) return reply.code(400).send({ error: "Set engines.llamaServerPath in config.json first" });
    if (!req.body.modelPath.startsWith(s.paths.models)) {
      return reply.code(400).send({ error: "Only models inside the KesherAI models folder can be loaded" });
    }
    await s.llama.load(req.body.modelPath);
    if (!s.registry.get("llamacpp")) {
      s.registry.add({
        id: "llamacpp", type: "openai-compatible", name: "llama.cpp (managed)", location: "local",
        baseUrl: `http://127.0.0.1:${s.config.engines.llamaServerPort}/v1`,
      });
    }
    return s.llama.status();
  });

  app.post("/api/engines/llamacpp/stop", async () => {
    await s.llama?.stop();
    return { ok: true };
  });
}

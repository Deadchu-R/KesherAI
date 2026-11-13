import type { FastifyInstance } from "fastify";
import { mkdir, readdir, rmdir, stat, unlink } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { PROVIDER_PRESETS, type ProviderConfig } from "@kesher/providers";
import { detectHardwareCached, estimatePerformance } from "@kesher/downloads";
import type { KesherServices } from "../services.js";
import { scanComputer, scanFolder } from "../model-scan.js";
import { forgetFoundModels } from "./engine.js";
import { isLocalRequest } from "../auth.js";
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

/** The largest single model file the phone app can load (llama.cpp in WebAssembly). */
export const PHONE_MAX_BYTES = 1.95 * 1024 ** 3;

/**
 * Chat models on this computer small enough for the phone: GGUF files under
 * 2 GB, without vision projectors or embedding models. Each has a short id
 * (a hash of its path), so paths are not shown to the phone.
 *
 * @param s - Services (paths and model folders).
 * @returns The models, smallest first.
 */
export async function phoneModels(s: Pick<KesherServices, "paths" | "config">): Promise<Array<{ id: string; name: string; size: number; path: string }>> {
  const own = (await listFilesRecursive(s.paths.models)).map((path) => ({ path, name: basename(path) }));
  const extra = (await Promise.all(s.config.modelFolders.map((f) => scanFolder(f).catch(() => [])))).flat().map((m) => ({ path: m.path, name: basename(m.path) }));
  const out: Array<{ id: string; name: string; size: number; path: string }> = [];
  const seen = new Set<string>();
  for (const m of [...own, ...extra]) {
    if (seen.has(m.path) || !/\.gguf$/i.test(m.name) || /mmproj|embed|whisper|vae|clip|t5xxl|-\d{5}-of-\d{5}|qwen[-_ ]?image|flux|sdxl|stable[-_]?diffusion|wan2|z[-_]?image|umt5/i.test(m.name)) continue;
    seen.add(m.path);
    if (/[\\/](image|image-support|video|loras)[\\/]/i.test(relative(s.paths.models, m.path).replace(/^/, "/"))) continue;
    const size = (await stat(m.path).catch(() => undefined))?.size ?? 0;
    if (size < 50 * 1024 ** 2 || size > PHONE_MAX_BYTES) continue;
    out.push({ id: createHash("sha256").update(m.path).digest("hex").slice(0, 16), name: m.name.replace(/\.gguf$/i, ""), size, path: m.path });
  }
  return out.sort((a, b) => a.size - b.size);
}

/**
 * A model that comes in several files (`name-00001-of-00004.gguf`, …) is one model: one row with the whole
 * size, pointing at the first part (the engine finds the rest beside it). A model with parts missing (a download
 * that did not finish) says so, so it is not loaded half-there.
 *
 * @param files - Every model file found.
 * @returns The list with each split model as one entry.
 */
export function joinSplitModels<T extends { path: string; name: string; size: number }>(files: T[]): Array<T & { parts?: { have: number; of: number } }> {
  const part = /^(.*)-(\d{5})-of-(\d{5})(\.gguf)$/i;
  const groups = new Map<string, { of: number; first?: T; size: number; have: Set<number>; at: number }>();
  const out: Array<T & { parts?: { have: number; of: number } }> = [];
  for (const f of files) {
    const m = part.exec(f.path);
    if (!m) {
      out.push(f);
      continue;
    }
    const key = `${m[1]!.toLowerCase()}|${m[3]}`;
    let g = groups.get(key);
    if (!g) {
      g = { of: Number(m[3]), size: 0, have: new Set(), at: out.length };
      groups.set(key, g);
      out.push(f); // a place in the list, replaced below
    }
    g.size += f.size;
    g.have.add(Number(m[2]));
    if (Number(m[2]) === 1) g.first = f;
  }
  for (const g of groups.values()) {
    const shown = g.first ?? out[g.at]!;
    out[g.at] = { ...shown, name: shown.name.replace(/-\d{5}-of-\d{5}(\.gguf)$/i, "$1"), size: g.size, parts: { have: g.have.size, of: g.of } };
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

  /** Send a model to the phone: the computer's chat models that fit one, and each file (with resume). */
  app.get("/api/models/phone", async () => (await phoneModels(s)).map(({ path: _p, ...m }) => m));
  app.get<{ Params: { id: string } }>("/api/models/phone/:id", async (req, reply) => {
    const m = (await phoneModels(s)).find((x) => x.id === req.params.id);
    if (!m) return reply.code(404).send({ error: "No such model" });
    const range = /^bytes=(\d+)-(\d*)$/.exec(String(req.headers.range ?? ""));
    const start = range ? Number(range[1]) : 0;
    const end = range && range[2] ? Math.min(Number(range[2]), m.size - 1) : m.size - 1;
    if (start >= m.size) return reply.code(416).header("content-range", `bytes */${m.size}`).send();
    reply
      .header("accept-ranges", "bytes")
      .header("content-length", String(end - start + 1))
      .header("etag", `"${m.id}-${m.size}"`)
      .header("content-disposition", `attachment; filename="${encodeURIComponent(m.name)}.gguf"`)
      .type("application/octet-stream");
    if (range) reply.code(206).header("content-range", `bytes ${start}-${end}/${m.size}`);
    return reply.send(createReadStream(m.path, { start, end }));
  });

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
        const measured = await s.speeds.get(basename(path));
        return { path, name: relative(s.paths.models, path), size, source: "KesherAI", gguf: path.toLowerCase().endsWith(".gguf"), estimate: estimatePerformance(size, hw), ...(measured ? { measured } : {}) };
      }),
    );
    const others = await Promise.all(extra.flat().map(async (m) => {
      const measured = await s.speeds.get(basename(m.path));
      return { path: m.path, name: m.name, size: m.size, source: m.source, gguf: m.format === "gguf", estimate: estimatePerformance(m.size, hw), ...(measured ? { measured } : {}) };
    }));
    return joinSplitModels([...own, ...others]);
  });

  /**
   * Deletes a model KesherAI downloaded (like LM Studio's My Models trash button), after the user confirmed it.
   * Only files inside KesherAI's own models folder: other apps' models (LM Studio, Ollama…) are only read, never
   * deleted. Never the model the engine has loaded. Empty folders left behind go too.
   */
  app.post<{ Body: { path?: string } }>("/api/models/delete", async (req, reply) => {
    const path = resolve(String(req.body?.path ?? ""));
    const root = resolve(s.paths.models);
    if (!path.startsWith(root + sep)) return reply.code(400).send({ error: "Only models KesherAI downloaded can be deleted here (other apps' models stay as they are)." });
    if (resolve(s.engine.status().modelPath ?? "") === path) return reply.code(409).send({ error: "This model is loaded. Load another one (or stop the engine) first." });
    const st = await stat(path).catch(() => undefined);
    if (!st?.isFile()) return reply.code(404).send({ error: "No such model file." });
    try {
      await unlink(path);
    } catch (e) {
      return reply.code(409).send({ error: `It could not be deleted (another app may have it open): ${(e as Error).message}` });
    }
    // Remove the folders it leaves empty, up to the models folder.
    for (let d = dirname(path); d.startsWith(root + sep); d = dirname(d)) if (!(await rmdir(d).then(() => true, () => false))) break;
    forgetFoundModels();
    return { ok: true, freed: st.size };
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
    if (!isLocalRequest(req)) return reply.code(403).send({ error: "Model folders can only be changed on this computer." });
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
        forgetFoundModels();
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
    if (!isLocalRequest(req)) return reply.code(403).send({ error: "Scanning runs only on this computer." });
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

  /**
   * Cloud connections (API keys) shared between the computer and the phone
   * app. GET gives them with their keys, so only paired devices (holding the
   * remote token) and this computer can call it; PUT adds the phone's ones
   * the computer does not have yet (existing ones are kept).
   */
  app.get("/api/providers/sync", async () =>
    s.config.providers
      .filter((p) => (p.location ?? s.registry.list().find((r) => r.config.id === p.id)?.provider.location) === "cloud" && p.apiKey)
      .map(({ id, type, name, baseUrl, apiKey }) => ({ id, type, name: name ?? id, ...(baseUrl ? { baseUrl } : {}), apiKey })),
  );
  app.put<{ Body: { providers?: Array<{ id: string; type?: string; name?: string; baseUrl?: string; apiKey?: string }> } }>("/api/providers/sync", async (req, reply) => {
    const incoming = req.body?.providers ?? [];
    const added: string[] = [];
    for (const p of incoming) {
      if (!p?.id || !/^[a-z0-9-]+$/.test(p.id) || !p.apiKey) continue;
      if (s.config.providers.some((x) => x.id === p.id)) continue;
      const config: ProviderConfig = { id: p.id, type: p.type === "anthropic" ? "anthropic" : "openai-compatible", name: p.name ?? p.id, ...(p.baseUrl ? { baseUrl: p.baseUrl } : {}), apiKey: p.apiKey, location: "cloud" };
      try {
        s.registry.add(config);
        s.config.providers.push(config);
        added.push(p.id);
      } catch (err) {
        return reply.code(400).send({ error: `${p.id}: ${(err as Error).message}` });
      }
    }
    if (added.length) await s.saveConfig();
    return { added };
  });

  app.delete<{ Params: { id: string } }>("/api/providers/:id", async (req) => {
    s.registry.remove(req.params.id);
    s.config.providers = s.config.providers.filter((p) => p.id !== req.params.id);
    await s.saveConfig();
    return { ok: true };
  });

  await engineRoutes(app, s);
}

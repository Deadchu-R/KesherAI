import type { FastifyInstance } from "fastify";
import { activeFractionOf } from "../gguf.js";
import { mkdir, readdir, rmdir, stat, unlink } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { PROVIDER_PRESETS, type ProviderConfig } from "@kesher/providers";
import { detectHardwareCached, estimatePerformance, listHubFiles } from "@kesher/downloads";
import type { KesherServices } from "../services.js";
import { scanComputer, scanFolder } from "../model-scan.js";
import { forgetFoundModels } from "./engine.js";
import { findMmproj } from "../llamacpp.js";
import { isLocalRequest } from "../auth.js";
import { assertWritableFolder } from "../library.js";
import { ModelsMove } from "../models-move.js";
import { EDITOR, HEAVY_FOLDERS, HeavyFolder, enginesRunning, stopProcesses, suggestHeavyDir, type HeavyName } from "../heavy-folder.js";
import { engineRoutes } from "./engine.js";

/** The one move of the models folder that may run at a time. */
const mover = new ModelsMove();

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
        const st = await stat(path);
        const size = st.size;
        const measured = await s.speeds.get(basename(path));
        // Mixture-of-experts models read only their chosen experts per token: much faster than their size says.
        const activeFraction = await activeFractionOf(path, size, st.mtimeMs);
        return { path, name: relative(s.paths.models, path), size, source: "KesherAI", gguf: path.toLowerCase().endsWith(".gguf"), estimate: estimatePerformance(size, hw, activeFraction ? { activeFraction } : {}), ...(measured ? { measured } : {}) };
      }),
    );
    const others = await Promise.all(extra.flat().map(async (m) => {
      const measured = await s.speeds.get(basename(m.path));
      const st = m.format === "gguf" ? await stat(m.path).catch(() => undefined) : undefined;
      const activeFraction = st ? await activeFractionOf(m.path, m.size, st.mtimeMs) : undefined;
      return { path: m.path, name: m.name, size: m.size, source: m.source, gguf: m.format === "gguf", estimate: estimatePerformance(m.size, hw, activeFraction ? { activeFraction } : {}), ...(measured ? { measured } : {}) };
    }));
    // A split model's estimate is for all its parts together (the first part alone can be only its metadata).
    return joinSplitModels([...own, ...others]).map((m) => (m.parts ? { ...m, estimate: estimatePerformance(m.size, hw) } : m));
  });

  /**
   * Deletes a model KesherAI downloaded (like LM Studio's My Models trash button), after the user confirmed it.
   * Only files inside KesherAI's own models folder: other apps' models (LM Studio, Ollama…) are only read, never
   * deleted. Never the model the engine has loaded. Empty folders left behind go too.
   */
  // Vision for a downloaded model: its repository's mmproj (the picture encoder llama.cpp loads beside it). The
  // engine then loads it with the model, and the model sees attached pictures (found on the PC: Qwen3.8 had none).
  const visionFor = async (given: string) => {
    const path = resolve(given);
    const root = resolve(s.paths.models);
    if (!path.startsWith(root + sep) || !/\.gguf$/i.test(path)) return { error: "Only GGUF models KesherAI downloaded." } as const;
    if (await findMmproj(path)) return { path, has: true } as const;
    // models/<category>/<owner>/<repo>/…: the repository it came from.
    const parts = relative(root, path).split(sep);
    if (parts.length < 4) return { path, has: false } as const;
    const repo = `${parts[1]}/${parts[2]}`;
    const files = await listHubFiles(repo, { signal: AbortSignal.timeout(15_000) }).catch(() => []);
    const mm = files.filter((f) => /mmproj.*\.gguf$/i.test(f.path)).sort((a, b) => (/f16/i.test(b.path) && !/bf16/i.test(b.path) ? 1 : 0) - (/f16/i.test(a.path) && !/bf16/i.test(a.path) ? 1 : 0) || a.size - b.size)[0];
    return { path, has: false, repo, ...(mm ? { offer: mm } : {}) } as const;
  };
  app.get<{ Querystring: { path?: string } }>("/api/models/vision", async (req, reply) => {
    const v = await visionFor(String(req.query.path ?? ""));
    if ("error" in v) return reply.code(400).send(v);
    return { has: v.has, ...("offer" in v && v.offer ? { offer: { name: basename(v.offer.path), size: v.offer.size } } : {}) };
  });
  app.post<{ Body: { path?: string } }>("/api/models/vision", async (req, reply) => {
    const v = await visionFor(String(req.body?.path ?? ""));
    if ("error" in v) return reply.code(400).send(v);
    if (v.has) return { ok: true, has: true };
    if (!("offer" in v) || !v.offer) return reply.code(404).send({ error: "This model's repository has no vision file (mmproj)." });
    const job = s.downloads.enqueue({ url: v.offer.url, dest: join(dirname(v.path), basename(v.offer.path)), size: v.offer.size, ...(v.offer.sha256 ? { sha256: v.offer.sha256 } : {}), label: `👁 ${basename(v.offer.path)} (${basename(v.path)})` });
    return { ok: true, id: job.id };
  });

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

  /**
   * Moves the models of one of the extra folders into the download folder (another drive too): `{ from }`. Only from
   * this computer. Progress at GET; DELETE stops it. A folder emptied completely leaves the list by itself.
   */
  const heavy = new HeavyFolder(s.paths.root, async (pending) => {
    s.config.heavyPending = pending;
    await s.saveConfig();
  });
  app.post<{ Body: { from?: string } }>("/api/models/move", async (req, reply) => {
    if (!isLocalRequest(req)) return reply.code(403).send({ error: "Models can only be moved on this computer." });
    const from = String(req.body?.from ?? "");
    if (!s.config.modelFolders.some((f) => f.folder === from)) return reply.code(400).send({ error: "Choose one of the folders KesherAI reads models from." });
    const to = s.paths.models;
    const st = mover.start(from, to);
    void mover.idle().then(async () => {
      const done = mover.status();
      if (!done.error && !done.kept.length && done.from === from) {
        s.config.modelFolders = s.config.modelFolders.filter((f) => f.folder !== from);
        await s.saveConfig().catch(() => undefined);
      }
      forgetFoundModels();
    });
    return st;
  });
  app.get("/api/models/move", async () => mover.status());
  app.delete("/api/models/move", async () => {
    mover.cancel();
    return mover.status();
  });

  /**
   * The folder for heavy things (heavy-folder.ts): GET each heavy folder's size and where it lives; POST `{ dir, names }`
   * copies them there (this computer only) and they finish moving at the next start; DELETE stops the copy.
   */
  app.get("/api/heavy", async () => ({
    dir: s.config.heavyDir ?? suggestHeavyDir(s.paths.models, s.paths.root),
    saved: !!s.config.heavyDir,
    folders: await heavy.folders(),
    pending: s.config.heavyPending,
    copy: heavy.status(),
    canRestart: !!s.restartApp,
  }));
  app.post<{ Body: { dir?: string; names?: string[] } }>("/api/heavy", async (req, reply) => {
    if (!isLocalRequest(req)) return reply.code(403).send({ error: "Only on this computer." });
    const dir = String(req.body?.dir ?? "").trim();
    if (!isAbsolute(dir)) return reply.code(400).send({ error: "Write a full folder path, e.g. E:\\KesherAI." });
    const names = (Array.isArray(req.body?.names) ? req.body.names : HEAVY_FOLDERS).map(String) as HeavyName[];
    const st = heavy.start(dir, names);
    s.config.heavyDir = dir;
    await s.saveConfig();
    return st;
  });
  app.delete("/api/heavy", async () => {
    heavy.cancel();
    return heavy.status();
  });
  app.post<{ Body: { closeEditors?: boolean } }>("/api/heavy/restart", async (req, reply) => {
    if (!isLocalRequest(req) || !s.restartApp) return reply.code(403).send({ error: "Restart KesherAI yourself to finish." });
    // KesherAI's own engines keep running across a restart (the chat model, ComfyUI, the tunnel), and a running program
    // holds its folder: they are stopped first so the engines folder can move. An editor (Godot, …) the user may be
    // working in is not closed without their say.
    if (s.config.heavyPending.some((p) => p.name === "engines")) {
      const running = await enginesRunning(join(s.paths.root, "engines"));
      const editors = running.filter((p) => EDITOR.test(p.name));
      if (editors.length && !req.body?.closeEditors) return reply.code(409).send({ error: "Close these first, or let KesherAI close them.", code: "editors-open", category: [...new Set(editors.map((e) => e.name))].join(", ") });
      await stopProcesses(running.map((p) => p.id));
    }
    setTimeout(() => s.restartApp?.(), 300);
    return { restarting: true };
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
        // The old download folder stays a folder models are read from (nothing is lost, nothing downloads again);
        // "move" brings them over later.
        const before = s.paths.models;
        const hasFiles = (await readdir(before).catch(() => [])).length > 0;
        if (hasFiles && !s.config.modelFolders.some((f) => f.folder === before)) s.config.modelFolders = [...s.config.modelFolders, { folder: before, source: "Earlier download folder" }];
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

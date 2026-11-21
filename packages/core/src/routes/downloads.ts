import type { FastifyInstance } from "fastify";
import { join, normalize, sep } from "node:path";
import { mkdir, readFile, statfs, writeFile } from "node:fs/promises";
import { budgetOf, detectHardwareCached, estimatePerformance, estimateRepoFit, estimateRunFit, fileKind, listHubFiles, modelSummary, quantOf, searchHub, splitGroup, type DownloadJob, type HubFile, type HubSort } from "@kesher/downloads";
import type { KesherServices } from "../services.js";
import { RECOMMENDED_IMAGE_MODELS, isMlx } from "../sdcpp.js";
import { existsSync } from "node:fs";
import { startSSE } from "../sse.js";
import { forgetFoundModels } from "./engine.js";
import { RECOMMENDED_MODELS } from "@kesher/shared";
import { pickStarterModels } from "../starter-models.js";

/** Body of `POST /api/downloads`. */
interface DownloadBody {
  /** Hugging Face repo id. */
  repo: string;
  /** File path inside the repo. */
  path: string;
  /** KesherAI category, decides the destination folder. */
  category?: string;
  /** Which drive to save to: `models` (the download folder) or `heavy` (the heavy-data folder); see {@link driveChoices}. */
  drive?: string;
}

/** A place a download can go, offered in the download box. */
export interface DriveChoice {
  id: "models" | "heavy";
  /** The folder the category sub-folders go under. */
  dir: string;
  freeGb?: number;
  totalGb?: number;
  /** The one picked unless the user picks another. */
  default: boolean;
}

/**
 * The drives a download can go to. The download folder always; the heavy-data folder too when the user set one that
 * is not already where models go (it is then the default, as heavy things belong there). Only chat-model files (GGUF)
 * can go elsewhere: the image, video and voice engines read the download folder only. The client sends an id, never
 * a path, so a download cannot be steered outside these folders.
 *
 * @param s - Services (paths, config).
 * @param path - The file's path in its repo.
 * @returns One or two choices, with free space.
 */
export async function driveChoices(s: Pick<KesherServices, "paths" | "config">, path: string): Promise<DriveChoice[]> {
  const models: DriveChoice = { id: "models", dir: s.paths.models, ...(await diskInfo(s.paths.models)), default: true };
  const heavy = s.config.heavyDir;
  if (!heavy || !/\.gguf$/i.test(path)) return [models];
  const dir = join(heavy, "models");
  if ((normalize(s.paths.models) + sep).startsWith(normalize(heavy) + sep)) return [models];
  const info = await diskInfo(heavy);
  return [{ id: "heavy", dir, ...info, default: true }, { ...models, default: false }];
}

/**
 * Picks where a downloaded file goes. Image models go into ComfyUI's
 * `models/checkpoints` (or `loras` for LoRA files) when the user told
 * KesherAI where ComfyUI lives; LoRAs otherwise into `models/loras`; everything else into KesherAI's own models
 * folder, one sub-folder per category and repo.
 *
 * @param s - Services (for paths and config).
 * @param body - Download request.
 * @param root - The chosen drive's folder (see {@link driveChoices}); the download folder when left out.
 * @returns Absolute destination path.
 * @throws Error if the path tries to escape its folder.
 */
export function destinationFor(s: Pick<KesherServices, "paths" | "config">, body: DownloadBody, root?: string): string {
  const fileName = body.path.split("/").pop() ?? body.path;
  let base: string;
  let dest: string;
  if (body.category === "image" && s.config.comfyui.modelsDir) {
    base = s.config.comfyui.modelsDir;
    dest = join(base, /lora/i.test(body.repo + body.path) ? "loras" : "checkpoints", fileName);
  } else if (body.category === "image" && /lora/i.test(body.repo + body.path)) {
    // LoRAs go together into one folder, where the image engine finds them by name.
    base = s.paths.models;
    dest = join(base, "loras", fileName);
  } else {
    base = root ?? s.paths.models;
    // A model file asked for without a category (the API, a script): a .gguf is a chat model, which is where the chat
    // and Study look (found on the PC: a vision model landed in "other" and photos could not find it).
    dest = join(base, body.category ?? (/\.gguf$/i.test(body.path) ? "chat" : "other"), body.repo, body.path);
  }
  const normalized = normalize(dest);
  if (!normalized.startsWith(normalize(base) + sep)) throw new Error("Invalid file path");
  return normalized;
}

/** Free and total space of the drive holding `dir`. */
async function diskInfo(dir: string): Promise<{ freeGb?: number; totalGb?: number }> {
  try {
    const st = await statfs(dir);
    return { freeGb: (st.bavail * st.bsize) / 1024 ** 3, totalGb: (st.blocks * st.bsize) / 1024 ** 3 };
  } catch {
    return {};
  }
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * A repo's files marked for this computer. Weights get their quant, kind (a vision add-on is `mmproj`), the run mark
 * (the parts of a split GGUF counted together) and, for chat models, the speed estimate.
 *
 * @param files - From listHubFiles.
 * @param hw - This computer.
 * @param pipelineTag - The repo's task (decides image/video/voice working memory).
 * @param activeFraction - Share of weights used per token for mixture-of-experts models.
 * @returns The files with `quant`, `kind`, `fit` and `estimate` where they apply.
 */
export function markFiles(files: HubFile[], hw: Parameters<typeof budgetOf>[0] & Parameters<typeof estimatePerformance>[1], pipelineTag?: string, activeFraction?: number) {
  const budget = budgetOf(hw);
  const groupSize = new Map<string, number>();
  for (const f of files) if (/\.gguf$/i.test(f.path)) groupSize.set(splitGroup(f.path), (groupSize.get(splitGroup(f.path)) ?? 0) + f.size);
  return files.map((f) => {
    if (!/\.(gguf|safetensors)$/i.test(f.path)) return f;
    const kind = fileKind(f.path, pipelineTag);
    const size = groupSize.get(splitGroup(f.path)) ?? f.size;
    const quant = quantOf(f.path);
    const r = estimateRunFit(size, budget, { kind });
    return {
      ...f,
      kind,
      ...(quant ? { quant } : {}),
      fit: { fit: r.fit, needGb: round1(r.needBytes / 1024 ** 3), gpuShare: r.gpuShare },
      ...(kind === "llm" ? { estimate: estimatePerformance(size, hw, activeFraction ? { activeFraction } : {}) } : {}),
    };
  });
}

/** A clear message for network failures, which Node reports only as "fetch failed". */
function hubError(err: unknown): string {
  const e = err as Error & { cause?: { code?: string; message?: string } };
  const code = e.cause?.code;
  if (e.message === "fetch failed" || code) {
    return `Could not reach Hugging Face (${code ?? e.cause?.message ?? "network error"}). Check the internet connection, a VPN or a firewall, then try again.`;
  }
  return e.message;
}

/**
 * Hugging Face search and the download queue.
 *
 * @param app - Fastify instance.
 * @param s - Services.
 */
export async function downloadRoutes(app: FastifyInstance, s: KesherServices): Promise<void> {
  const token = () => s.config.huggingFaceToken;

  app.get<{ Querystring: { q?: string; pipelineTag?: string; filter?: string; sort?: string; limit?: string } }>("/api/hub/search", async (req, reply) => {
    const sorts: HubSort[] = ["downloads", "likes", "trending", "created", "modified"];
    const sort = sorts.find((x) => x === req.query.sort) ?? "downloads";
    try {
      const [models, hw] = await Promise.all([searchHub({
        ...(req.query.q ? { search: req.query.q } : {}),
        ...(req.query.pipelineTag ? { pipelineTag: req.query.pipelineTag } : {}),
        ...(req.query.filter ? { filter: req.query.filter } : {}),
        sort,
        limit: Math.min(100, Number(req.query.limit ?? 40) || 40),
        ...(token() ? { token: token() } : {}),
      }), detectHardwareCached().catch(() => undefined)]);
      // Each result marked for this computer (the PC's hardware, also when the phone asks).
      if (!hw) return models;
      const budget = budgetOf(hw);
      return models.map((m) => {
        const gguf = m.library === "gguf" || m.tags.includes("gguf");
        const r = estimateRepoFit({ gguf, ...(m.paramCount ? { params: m.paramCount } : {}), ...(m.parameters ? { parameters: m.parameters } : {}), ...(m.dtypeBytes ? { dtypeBytes: m.dtypeBytes } : {}), ...(m.pipelineTag ? { pipelineTag: m.pipelineTag } : {}) }, budget);
        return { ...m, fit: { fit: r.fit, needGb: round1(r.needBytes / 1024 ** 3), sizeGb: round1(r.assumedBytes / 1024 ** 3), gpuShare: r.gpuShare } };
      });
    } catch (err) {
      return reply.code(502).send({ error: hubError(err) });
    }
  });

  /** A short description from the model card. */
  app.get<{ Querystring: { repo: string } }>("/api/hub/summary", async (req, reply) => {
    try {
      return { summary: await modelSummary(req.query.repo, { ...(token() ? { token: token() } : {}) }) };
    } catch (err) {
      return reply.code(502).send({ error: hubError(err) });
    }
  });

  /** A repo's files; model weights carry a performance estimate for this computer. */
  app.get<{ Querystring: { repo: string; pipelineTag?: string } }>("/api/hub/files", async (req, reply) => {
    let files: Awaited<ReturnType<typeof listHubFiles>>;
    try {
      files = await listHubFiles(req.query.repo, { ...(token() ? { token: token() } : {}) });
    } catch (err) {
      return reply.code(502).send({ error: hubError(err) });
    }
    const hw = await detectHardwareCached();
    // Mixture-of-experts repos usually say so in the name ("A3B" = 3B active parameters).
    const moe = /-A(\d+(?:\.\d+)?)B/i.exec(req.query.repo);
    const total = /(\d+(?:\.\d+)?)B/i.exec(req.query.repo.replace(/-A\d+(?:\.\d+)?B/i, ""));
    const activeFraction = moe && total ? Number(moe[1]) / Number(total[1]) : undefined;
    return markFiles(files, hw, req.query.pipelineTag, activeFraction);
  });

  /** Image models that run in the built-in engine, with whether each is downloaded. */
  // Never empty because one check failed (found on Linux with an AMD card: the list did not show at all): each
  // part falls back, and what failed goes to the fault log.
  app.get("/api/models/recommended-images", async () => {
    const hw = await detectHardwareCached().catch((err: Error) => {
      s.faults.add({ kind: "other", where: "recommended image models: hardware", message: err.message });
      return { gpus: [] as Array<{ vramTotal: number }> };
    });
    const vramGb = Math.max(0, ...hw.gpus.map((g) => g.vramTotal / 1024 ** 3));
    return Promise.all(
      RECOMMENDED_IMAGE_MODELS.map(async (m) => {
        const dest = join(s.paths.models, "image", m.repo, m.file);
        const req = await s.sd.requirements(m.file).catch((err: Error) => {
          s.faults.add({ kind: "other", where: "recommended image models: engine", message: err.message });
          return { extras: [] as Array<{ name: string; repo: string; sizeGb: number; have: boolean }>, engineInstalled: false };
        });
        return { ...m, downloaded: existsSync(dest), extras: req.extras, engineInstalled: req.engineInstalled, vramGb };
      }),
    );
  });

  /** Free space on the drive models are saved to. */
  app.get("/api/disk", async () => diskInfo(s.paths.models));

  /**
   * The welcome's hardware check: the graphics card and memory, the drives a model can be saved to (the heavy-data
   * drive first when there is one), and 1–3 starter models from the "Start here" list with their run marks.
   * Query: `roles` (comma-separated role ids), `lang` (`he` adds the Hebrew model for writers and students).
   */
  app.get<{ Querystring: { roles?: string; lang?: string } }>("/api/welcome/check", async (req) => {
    const hw = await detectHardwareCached().catch(() => undefined);
    const roles = String(req.query.roles ?? "").split(",").map((r) => r.trim()).filter(Boolean).slice(0, 20);
    const budget = hw ? budgetOf(hw) : undefined;
    const gpu = hw?.gpus.slice().sort((a, b) => b.vramTotal - a.vramTotal)[0];
    return {
      gpu: gpu ? { name: gpu.name, vramGb: round1(gpu.vramTotal / 1024 ** 3) } : null,
      ramGb: hw ? round1(hw.ramTotal / 1024 ** 3) : null,
      unified: hw?.unifiedMemory ?? false,
      drives: await driveChoices(s, "model.gguf"),
      picks: budget ? pickStarterModels(RECOMMENDED_MODELS, budget, { roles, hebrew: req.query.lang === "he" }) : [],
    };
  });

  /**
   * Everything a download involves, shown before it starts: the file, the
   * extra files and engine it needs to run, the total, the free disk space,
   * and whether it fits this computer's memory.
   */
  app.get<{ Querystring: { repo: string; path: string; category?: string; size?: string; drive?: string } }>("/api/downloads/plan", async (req, reply) => {
    const { repo, path, category } = req.query;
    let size = Number(req.query.size);
    if (!Number.isFinite(size) || size <= 0) {
      try {
        size = (await listHubFiles(repo, { ...(token() ? { token: token() } : {}) })).find((f) => f.path === path)?.size ?? 0;
      } catch (err) {
        return reply.code(502).send({ error: hubError(err) });
      }
    }
    const items: Array<{ name: string; sizeGb: number; have: boolean; why: string }> = [{ name: path.split("/").pop() ?? path, sizeGb: size / 1024 ** 3, have: false, why: "model" }];
    const isImage = category === "image" || /qwen[-_ ]?image|flux|sdxl|stable[-_]?diffusion/i.test(repo + path);
    if (isImage && /\.(gguf|safetensors|ckpt)$/i.test(path)) {
      const r = await s.sd.requirements(path);
      for (const e of r.extras) items.push({ name: e.name, sizeGb: e.sizeGb, have: e.have, why: "extra" });
      if (!r.engineInstalled) items.push({ name: "stable-diffusion.cpp", sizeGb: process.platform === "win32" ? 0.4 : 0.05, have: false, why: "engine" });
    } else if (/\.gguf$/i.test(path) && !s.engine.status().installed) {
      items.push({ name: "llama.cpp", sizeGb: process.platform === "win32" ? 0.68 : 0.04, have: false, why: "engine" });
    }
    const totalGb = items.filter((i) => !i.have).reduce((n, i) => n + i.sizeGb, 0);
    const drives = await driveChoices(s, path);
    const disk = drives.find((d) => d.id === req.query.drive) ?? drives.find((d) => d.default) ?? drives[0]!;
    const hw = await detectHardwareCached();
    const mlx = isMlx(`${repo}/${path}`) && process.platform !== "darwin";
    return {
      items,
      ...(mlx ? { warning: "mlx" } : {}),
      totalGb,
      freeGb: disk.freeGb,
      fitsDisk: disk.freeGb === undefined || disk.freeGb > totalGb + 1,
      estimate: estimatePerformance(size, hw),
      drives,
      drive: disk.id,
    };
  });

  app.get("/api/downloads", async () => s.downloads.list());

  /** The download speed limit in MB/s (0: none). */
  app.get("/api/downloads/limit", async () => ({ mbps: s.config.downloadLimitMBps }));
  app.put<{ Body: { mbps?: number } }>("/api/downloads/limit", async (req, reply) => {
    const v = Number(req.body?.mbps);
    if (!Number.isFinite(v) || v < 0 || v > 10_000) return reply.code(400).send({ error: "A number of MB/s, 0 for no limit." });
    s.config.downloadLimitMBps = v;
    s.downloads.limit = v * 1024 * 1024;
    await s.saveConfig();
    return { mbps: v };
  });

  /**
   * Downloads that were not finished when KesherAI closed (an update, a restart) start again by themselves and
   * continue from their `.part` file. What is kept is only which file of which repo, never a token.
   */
  const pendingFile = join(s.paths.root, "downloads-pending.json");
  const pending = new Map<string, DownloadBody>();
  /** The downloads a close cut off, until each starts again (the card's Drop can still take one out). */
  let toStart: DownloadBody[] = [];
  // Started ones, and the ones a restart has not started again yet (once each).
  const savePending = () => {
    const all = new Map([...pending.values(), ...toStart].map((b) => [`${b.repo}\n${b.path}`, b]));
    return writeFile(pendingFile, JSON.stringify([...all.values()]), "utf8").catch(() => undefined);
  };
  const start = async (body: DownloadBody): Promise<DownloadJob | { refused: number; error: string }> => {
    const files = await listHubFiles(body.repo, { token: token() });
    const file = files.find((f) => f.path === body.path);
    if (!file) return { refused: 404, error: "File not found in repo" };
    const drives = await driveChoices(s, body.path);
    const drive = body.drive ? drives.find((d) => d.id === body.drive) : drives.find((d) => d.default);
    if (!drive) return { refused: 400, error: "Choose one of the offered drives." };
    if (drive.freeGb !== undefined && drive.freeGb < file.size / 1024 ** 3 + 1) {
      return { refused: 507, error: `Not enough disk space: the file needs ${(file.size / 1024 ** 3).toFixed(1)} GB and ${drive.freeGb.toFixed(1)} GB is free. Free some space or choose another drive.` };
    }
    if (drive.id === "heavy") {
      // The chat finds models in the folders it reads from: add the heavy drive's models folder once.
      await mkdir(drive.dir, { recursive: true });
      if (!s.config.modelFolders.some((f) => f.folder === drive.dir)) {
        s.config.modelFolders = [...s.config.modelFolders, { folder: drive.dir, source: "Heavy-data drive" }];
        await s.saveConfig();
        forgetFoundModels();
      }
    }
    const job = s.downloads.enqueue({
      url: file.url,
      dest: destinationFor(s, body, drive.dir),
      size: file.size,
      ...(file.sha256 ? { sha256: file.sha256 } : {}),
      ...(token() ? { headers: { authorization: `Bearer ${token()}` } } : {}),
      label: `${body.repo} · ${body.path}`,
    });
    pending.set(job.id, { repo: body.repo, path: body.path, ...(body.category ? { category: body.category } : {}), drive: drive.id });
    void savePending();
    return job;
  };
  // Finished, or cancelled by the user: no longer pending. A failed one stays, and is tried again at the next start.
  s.downloads.on("update", (job: DownloadJob) => {
    if ((job.status === "done" || job.status === "cancelled") && pending.delete(job.id)) void savePending();
  });
  const restarted = readFile(pendingFile, "utf8").then(
    (text) => {
      const list = (JSON.parse(text) as DownloadBody[]).filter((b) => typeof b?.repo === "string" && typeof b?.path === "string").slice(0, 50);
      toStart = [...list];
      // A little after start, so the network and the models folder are ready.
      const t = setTimeout(() => void (async () => {
        for (const b of list) if (toStart.includes(b)) await start(b).catch(() => undefined);
        toStart = [];
        void savePending();
      })(), 8000);
      t.unref?.();
      return list;
    },
    () => [] as DownloadBody[],
  );
  // On the "Continue what was running" card: they go on by themselves (the user started them); Drop cancels one.
  const labelOf = (b: DownloadBody) => `${b.repo} · ${b.path}`;
  const jobOf = (label: string) => s.downloads.list().find((j) => j.label === label && !["done", "failed", "cancelled"].includes(j.status));
  s.resume?.add("download", {
    found: async () =>
      (await restarted).map((b) => ({ id: `download:${labelOf(b)}`.slice(0, 300), source: "download", kind: "download" as const, title: labelOf(b).slice(0, 300), at: new Date().toISOString(), auto: true, link: "#/models", ref: labelOf(b).slice(0, 1000) })),
    alive: (i) => toStart.some((b) => labelOf(b) === i.ref) || !!jobOf(i.ref),
    continue: async () => undefined,
    drop: async (i) => {
      toStart = toStart.filter((b) => labelOf(b) !== i.ref);
      const job = jobOf(i.ref);
      if (job) s.downloads.cancel(job.id);
      else for (const [id, b] of pending) if (labelOf(b) === i.ref) pending.delete(id);
      void savePending();
    },
  });

  app.post<{ Body: DownloadBody }>("/api/downloads", async (req, reply) => {
    try {
      const r = await start(req.body);
      return "refused" in r ? reply.code(r.refused).send({ error: r.error }) : r;
    } catch (err) {
      return reply.code(400).send({ error: hubError(err) });
    }
  });

  /** Starts a failed or cancelled download again (it resumes where it stopped). */
  app.post<{ Params: { id: string } }>("/api/downloads/:id/pause", async (req) => ({ ok: s.downloads.pause(req.params.id) }));

  app.post<{ Params: { id: string } }>("/api/downloads/:id/retry", async (req, reply) => {
    const job = s.downloads.list().find((j) => j.id === req.params.id);
    if (!job) return reply.code(404).send({ error: "Download not found" });
    return s.downloads.retry(req.params.id);
  });

  /** Cancels a running download, or removes a finished one from the list. */
  app.delete<{ Params: { id: string } }>("/api/downloads/:id", async (req) => ({ ok: s.downloads.cancel(req.params.id) || s.downloads.dismiss(req.params.id) }));

  /** Live download progress as Server-Sent Events, one `DownloadJob` per event. */
  app.get("/api/downloads/events", async (req, reply) => {
    const sse = startSSE(req, reply);
    const onUpdate = (job: DownloadJob) => sse.send(job);
    s.downloads.on("update", onUpdate);
    for (const job of s.downloads.list()) sse.send(job);
    sse.closed.addEventListener("abort", () => s.downloads.off("update", onUpdate));
  });
}

import type { FastifyInstance } from "fastify";
import { join, normalize, sep } from "node:path";
import { statfs } from "node:fs/promises";
import { detectHardwareCached, estimatePerformance, listHubFiles, modelSummary, searchHub, type DownloadJob, type HubSort } from "@kesher/downloads";
import type { KesherServices } from "../services.js";
import { RECOMMENDED_IMAGE_MODELS, isMlx } from "../sdcpp.js";
import { existsSync } from "node:fs";
import { startSSE } from "../sse.js";

/** Body of `POST /api/downloads`. */
interface DownloadBody {
  /** Hugging Face repo id. */
  repo: string;
  /** File path inside the repo. */
  path: string;
  /** KesherAI category, decides the destination folder. */
  category?: string;
}

/**
 * Picks where a downloaded file goes. Image models go into ComfyUI's
 * `models/checkpoints` (or `loras` for LoRA files) when the user told
 * KesherAI where ComfyUI lives; everything else into KesherAI's own models
 * folder, one sub-folder per category and repo.
 *
 * @param s - Services (for paths and config).
 * @param body - Download request.
 * @returns Absolute destination path.
 * @throws Error if the path tries to escape its folder.
 */
export function destinationFor(s: Pick<KesherServices, "paths" | "config">, body: DownloadBody): string {
  const fileName = body.path.split("/").pop() ?? body.path;
  let base: string;
  let dest: string;
  if (body.category === "image" && s.config.comfyui.modelsDir) {
    base = s.config.comfyui.modelsDir;
    dest = join(base, /lora/i.test(body.repo + body.path) ? "loras" : "checkpoints", fileName);
  } else {
    base = s.paths.models;
    dest = join(base, body.category ?? "other", body.repo, body.path);
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
      return await searchHub({
        ...(req.query.q ? { search: req.query.q } : {}),
        ...(req.query.pipelineTag ? { pipelineTag: req.query.pipelineTag } : {}),
        ...(req.query.filter ? { filter: req.query.filter } : {}),
        sort,
        limit: Math.min(100, Number(req.query.limit ?? 40) || 40),
        ...(token() ? { token: token() } : {}),
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
  app.get<{ Querystring: { repo: string } }>("/api/hub/files", async (req, reply) => {
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
    return files.map((f) =>
      /\.(gguf|safetensors)$/i.test(f.path)
        ? { ...f, estimate: estimatePerformance(f.size, hw, activeFraction ? { activeFraction } : {}) }
        : f,
    );
  });

  /** Image models that run in the built-in engine, with whether each is downloaded. */
  app.get("/api/models/recommended-images", async () => {
    const hw = await detectHardwareCached();
    return Promise.all(
      RECOMMENDED_IMAGE_MODELS.map(async (m) => {
        const dest = join(s.paths.models, "image", m.repo, m.file);
        const req = await s.sd.requirements(m.file);
        return { ...m, downloaded: existsSync(dest), extras: req.extras, engineInstalled: req.engineInstalled, vramGb: Math.max(0, ...hw.gpus.map((g) => g.vramTotal / 1024 ** 3)) };
      }),
    );
  });

  /** Free space on the drive models are saved to. */
  app.get("/api/disk", async () => diskInfo(s.paths.models));

  /**
   * Everything a download involves, shown before it starts: the file, the
   * extra files and engine it needs to run, the total, the free disk space,
   * and whether it fits this computer's memory.
   */
  app.get<{ Querystring: { repo: string; path: string; category?: string; size?: string } }>("/api/downloads/plan", async (req, reply) => {
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
    const disk = await diskInfo(s.paths.models);
    const hw = await detectHardwareCached();
    const mlx = isMlx(`${repo}/${path}`) && process.platform !== "darwin";
    return {
      items,
      ...(mlx ? { warning: "mlx" } : {}),
      totalGb,
      freeGb: disk.freeGb,
      fitsDisk: disk.freeGb === undefined || disk.freeGb > totalGb + 1,
      estimate: estimatePerformance(size, hw),
    };
  });

  app.get("/api/downloads", async () => s.downloads.list());

  app.post<{ Body: DownloadBody }>("/api/downloads", async (req, reply) => {
    try {
      const files = await listHubFiles(req.body.repo, { token: token() });
      const file = files.find((f) => f.path === req.body.path);
      if (!file) return reply.code(404).send({ error: "File not found in repo" });
      const disk = await diskInfo(s.paths.models);
      if (disk.freeGb !== undefined && disk.freeGb < file.size / 1024 ** 3 + 1) {
        return reply.code(507).send({ error: `Not enough disk space: the file needs ${(file.size / 1024 ** 3).toFixed(1)} GB and ${disk.freeGb.toFixed(1)} GB is free. Free some space or choose another models folder.` });
      }
      return s.downloads.enqueue({
        url: file.url,
        dest: destinationFor(s, req.body),
        size: file.size,
        ...(file.sha256 ? { sha256: file.sha256 } : {}),
        ...(token() ? { headers: { authorization: `Bearer ${token()}` } } : {}),
        label: `${req.body.repo} · ${req.body.path}`,
      });
    } catch (err) {
      return reply.code(400).send({ error: hubError(err) });
    }
  });

  /** Starts a failed or cancelled download again (it resumes where it stopped). */
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

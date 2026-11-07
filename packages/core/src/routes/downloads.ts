import type { FastifyInstance } from "fastify";
import { join, normalize, sep } from "node:path";
import { detectHardwareCached, estimatePerformance, listHubFiles, modelSummary, searchHub, type DownloadJob, type HubSort } from "@kesher/downloads";
import type { KesherServices } from "../services.js";
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

  app.get("/api/downloads", async () => s.downloads.list());

  app.post<{ Body: DownloadBody }>("/api/downloads", async (req, reply) => {
    try {
      const files = await listHubFiles(req.body.repo, { token: token() });
      const file = files.find((f) => f.path === req.body.path);
      if (!file) return reply.code(404).send({ error: "File not found in repo" });
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

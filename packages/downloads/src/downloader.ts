import { EventEmitter } from "node:events";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, stat, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

/** Lifecycle of a download. */
export type DownloadStatus = "queued" | "downloading" | "verifying" | "done" | "failed" | "cancelled";

/** What to download and where. */
export interface DownloadRequest {
  /** Direct URL. */
  url: string;
  /** Final absolute path. The file is written to `<dest>.part` until verified. */
  dest: string;
  /** Expected size in bytes, if known; used for progress. */
  size?: number;
  /** Expected SHA-256 (hex). When set, a mismatch fails the job and deletes the file. */
  sha256?: string;
  /** Extra request headers, e.g. a Hugging Face token. */
  headers?: Record<string, string>;
  /** Free-form label for the UI, e.g. `city96/FLUX.1-dev-gguf · Q4_K_S`. */
  label?: string;
}

/** A download job as reported to the UI. */
export interface DownloadJob {
  id: string;
  label: string;
  url: string;
  dest: string;
  status: DownloadStatus;
  /** Bytes on disk so far. */
  received: number;
  /** Total bytes, when known. */
  total?: number;
  /** Bytes per second over the last second or so. */
  speed: number;
  error?: string;
}

/**
 * A download queue that resumes interrupted files and verifies hashes.
 *
 * - Runs up to `concurrency` jobs at once (default 1: big files download
 *   faster one at a time and the order stays predictable).
 * - Resumes from an existing `.part` file using an HTTP `Range` request.
 * - Emits `"update"` with a {@link DownloadJob} whenever a job changes.
 *
 * @example
 * ```ts
 * const dm = new DownloadManager();
 * dm.on("update", (job) => console.log(job.status, job.received));
 * dm.enqueue({ url, dest: "/models/x.gguf", sha256 });
 * ```
 */
export class DownloadManager extends EventEmitter<{ update: [DownloadJob] }> {
  private readonly jobs = new Map<string, { job: DownloadJob; req: DownloadRequest; abort?: AbortController }>();
  private active = 0;

  /** @param concurrency - How many downloads run at the same time. */
  constructor(private readonly concurrency = 1) {
    super();
  }

  /**
   * Adds a download to the queue.
   *
   * @param req - What to download.
   * @returns A snapshot of the new job.
   */
  enqueue(req: DownloadRequest): DownloadJob {
    const job: DownloadJob = {
      id: randomUUID(),
      label: req.label ?? req.dest,
      url: req.url,
      dest: req.dest,
      status: "queued",
      received: 0,
      ...(req.size !== undefined ? { total: req.size } : {}),
      speed: 0,
    };
    this.jobs.set(job.id, { job, req });
    this.emit("update", { ...job });
    this.pump();
    return { ...job };
  }

  /** @returns Snapshots of all jobs, newest last. */
  list(): DownloadJob[] {
    return [...this.jobs.values()].map(({ job }) => ({ ...job }));
  }

  /**
   * Cancels a queued or running job. The `.part` file is kept so the
   * download can resume later.
   *
   * @param id - Job id.
   * @returns `true` if the job existed and was not finished.
   */
  cancel(id: string): boolean {
    const entry = this.jobs.get(id);
    if (!entry || ["done", "failed", "cancelled"].includes(entry.job.status)) return false;
    entry.abort?.abort();
    this.update(entry.job, { status: "cancelled" });
    return true;
  }

  private update(job: DownloadJob, patch: Partial<DownloadJob>): void {
    Object.assign(job, patch);
    this.emit("update", { ...job });
  }

  private pump(): void {
    for (const entry of this.jobs.values()) {
      if (this.active >= this.concurrency) return;
      if (entry.job.status !== "queued") continue;
      this.active++;
      this.run(entry).finally(() => {
        this.active--;
        this.pump();
      });
    }
  }

  private async run(entry: { job: DownloadJob; req: DownloadRequest; abort?: AbortController }): Promise<void> {
    const { job, req } = entry;
    const part = `${req.dest}.part`;
    entry.abort = new AbortController();
    try {
      await mkdir(dirname(req.dest), { recursive: true });
      const existing = await stat(part).then((s) => s.size).catch(() => 0);
      const headers: Record<string, string> = { ...req.headers, ...(existing > 0 ? { range: `bytes=${existing}-` } : {}) };
      this.update(job, { status: "downloading", received: existing });

      const res = await fetch(req.url, { headers, signal: entry.abort.signal, redirect: "follow" });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} ${res.statusText}`);

      // 206 = the server honoured the Range header; anything else restarts from zero.
      const resumed = res.status === 206 && existing > 0;
      const start = resumed ? existing : 0;
      const length = Number(res.headers.get("content-length") ?? NaN);
      if (job.total === undefined && Number.isFinite(length)) job.total = start + length;
      this.update(job, { received: start });

      let windowBytes = 0;
      let windowStart = Date.now();
      const body = Readable.fromWeb(res.body as import("node:stream/web").ReadableStream<Uint8Array>);
      body.on("data", (chunk: Buffer) => {
        job.received += chunk.length;
        windowBytes += chunk.length;
        const elapsed = Date.now() - windowStart;
        if (elapsed >= 1000) {
          this.update(job, { speed: Math.round((windowBytes * 1000) / elapsed) });
          windowBytes = 0;
          windowStart = Date.now();
        }
      });
      await pipeline(body, createWriteStream(part, { flags: resumed ? "a" : "w" }));

      if (req.sha256) {
        this.update(job, { status: "verifying", speed: 0 });
        const actual = await sha256File(part);
        if (actual.toLowerCase() !== req.sha256.toLowerCase()) {
          await unlink(part).catch(() => undefined);
          throw new Error(`SHA-256 mismatch: expected ${req.sha256}, got ${actual}`);
        }
      }
      await rename(part, req.dest);
      this.update(job, { status: "done", speed: 0, received: job.total ?? job.received });
    } catch (err) {
      if (job.status === "cancelled") return;
      this.update(job, { status: "failed", speed: 0, error: err instanceof Error ? err.message : String(err) });
    }
  }
}

/**
 * Hashes a file with SHA-256 without loading it into memory.
 *
 * @param path - File to hash.
 * @returns Lower-case hex digest.
 */
export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}

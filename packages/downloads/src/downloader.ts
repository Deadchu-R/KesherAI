import { EventEmitter } from "node:events";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, open, rename, stat, statfs, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { PARALLEL_MIN_BYTES, Pacer, RangesRefused, downloadParts, loadParts, partsFilePath, planParts, probeRanges, removeParts, saveParts } from "./parallel.js";
import { DEFAULT_BUSY_SHARE, busyMode, slowedLimit, type BusyMode, type BusyState } from "./busy.js";
import { AUTO_VERIFY_BYTES, SCAN_BLOCK, hashesMatch, planRepair, scanFile, type ByteRange, type RepairPlan } from "./verify.js";
import { RateMeter, classifyDownloadError, secondsLeft, type DownloadErrorKind } from "./progress.js";

/** Lifecycle of a download. */
export type DownloadStatus = "queued" | "downloading" | "paused" | "verifying" | "done" | "failed" | "cancelled";

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
  /** The Hugging Face repo and file this is, so a finished download can be verified against the hub again later. */
  hub?: { repo: string; path: string };
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
  /** Bytes per second, smoothed (a moving average over the last few seconds, so it does not jump). */
  speed: number;
  /** Seconds left at the smoothed speed; absent when it cannot be told yet. */
  etaSeconds?: number;
  /** While `verifying`: bytes of the file hashed so far (of `received`). */
  verified?: number;
  error?: string;
  /** Why it failed, for the error card and its fix button; see {@link classifyDownloadError}. */
  errorKind?: DownloadErrorKind;
  /** While `queued`: the place in the line (1 starts next). Absent for every other status. */
  position?: number;
  /** Why it is not at full speed: the chat is answering (`slowed`) or a game is in Play (`paused`, also while waiting). */
  busy?: "slowed" | "paused";
  /** The user's "Don't slow" mark: this download never slows or pauses for the chat or a game. */
  dontSlow?: boolean;
  /** Started from the Hugging Face hub: a hash can be fetched for it when it has none (an old job). */
  fromHub?: true;
  /** The hub's SHA-256 for this file, when known: the Verify button shows only then. */
  sha256?: string;
  /** The last check of the finished file: `ok` (same as the hub) or `bad` (it differs: Repair). */
  integrity?: "ok" | "bad";
  /** What Repair will do (`bad`) or is doing (`repairing`): fetch only the broken ranges, or the whole file. */
  repair?: "ranges" | "whole";
  /** True while a repair downloads (the status is `downloading`, but it is the fix of a finished file). */
  repairing?: boolean;
}

/** What the manager keeps for each job. */
interface Entry {
  job: DownloadJob;
  req: DownloadRequest;
  abort?: AbortController;
  /** How the file was split into parts, when it was downloaded in parts (the repair uses it). */
  layout?: ByteRange[];
  /** What Repair will do after a bad check. */
  plan?: RepairPlan;
  /** A check or a repair of a finished file runs (Cancel then stops that, not the job). */
  checking?: boolean;
  /** Check the file after the next download whatever its size (a download that repairs a bad file). */
  verifyNext?: boolean;
}

/** Where {@link DownloadManager.move} puts a queued job: the front, one step earlier or later, or a place (0 is first). */
export type QueueMove = "top" | "up" | "down" | number;

/**
 * `fetch` that tries again when the server is briefly unwell: a 502, 503 or
 * 504 answer (GitHub's download servers do this at times) or a dropped
 * connection. It waits 2, 4 and 8 seconds between tries.
 *
 * @param url - What to fetch.
 * @param init - Fetch options (an abort signal stops the waiting too).
 * @param tries - How many tries in all.
 * @returns The last answer.
 */
export async function fetchRetrying(url: string, init: RequestInit = {}, tries = 4): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, init);
      if (![502, 503, 504].includes(res.status) || attempt >= tries) return res;
      await res.body?.cancel().catch(() => undefined);
    } catch (err) {
      if (init.signal?.aborted || attempt >= tries) throw err;
    }
    await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    if (init.signal?.aborted) throw new Error("Stopped.");
  }
}

/**
 * A download queue that resumes interrupted files and verifies hashes.
 *
 * - Runs up to `concurrency` jobs at once (default 1; the server passes the user's setting, 2 by default).
 * - The queue is the order of the jobs: the first queued job starts next, and {@link move} changes the order.
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
  private readonly jobs = new Map<string, Entry>();
  private active = 0;

  /** Bytes per second all downloads may use together (0: no limit), so the internet stays usable. */
  limit = 0;

  /**
   * Parts per big download (1 turns parallel parts off; at most 8). A file of {@link parallelMinBytes} or more is
   * split into this many ranges fetched at once, when the server allows ranges.
   */
  parts = 4;

  /** "Slow downloads while the PC is busy" (the chat answers: a share of the speed; a game in Play: pause). */
  slowWhenBusy = true;

  /** The share of the speed kept while the chat answers (0.1 to 1). */
  busyShare = DEFAULT_BUSY_SHARE;

  /** "Check big files after the download": files over 1 GB are checked against the hub's hash (smaller ones always are). */
  verifyBig = true;

  /** Tells what keeps the PC busy; the server sets it (the chat guard and the Play state). Read for every chunk. */
  busySource: () => BusyState = () => ({ chat: false, playing: false });

  /** The best combined speed seen while nothing slowed the downloads: "full speed" when there is no limit. */
  private peak = 0;

  /** The block size a verify scan looks for holes in (1 MiB; tests lower it). */
  scanBlock = SCAN_BLOCK;

  /** The size from which a file is downloaded in parts (1 GB; tests lower it). */
  parallelMinBytes = PARALLEL_MIN_BYTES;

  /** The first wait before a failed part is tried again; it doubles each time (tests shorten it). */
  partBackoffMs = 1000;

  /** @param concurrency - How many downloads run at the same time. */
  constructor(private concurrency = 1) {
    super();
  }

  /** @returns How many downloads may run at the same time. */
  get maxConcurrent(): number {
    return this.concurrency;
  }

  /**
   * Changes how many downloads run at the same time; a higher number starts waiting jobs at once, a lower one lets
   * running jobs finish (none is stopped).
   *
   * @param n - 1 or more.
   */
  setConcurrency(n: number): void {
    this.concurrency = Math.max(1, Math.floor(n));
    this.pump();
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
      ...(req.sha256 ? { sha256: req.sha256 } : {}),
      ...(req.hub ? { fromHub: true as const } : {}),
    };
    this.jobs.set(job.id, { job, req });
    this.renumber(job);
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
    if (entry?.checking) {
      // A check or repair of a finished file: stop that only; the file stays as it is.
      entry.abort?.abort();
      return true;
    }
    if (!entry || ["done", "failed", "cancelled"].includes(entry.job.status)) return false;
    this.update(entry.job, { status: "cancelled" });
    entry.abort?.abort();
    return true;
  }

  /**
   * Pauses a queued or running job (the `.part` file is kept); {@link retry} resumes it.
   *
   * @param id - Job id.
   * @returns `true` if it was paused.
   */
  pause(id: string): boolean {
    const entry = this.jobs.get(id);
    if (!entry || !["queued", "downloading"].includes(entry.job.status)) return false;
    // The user's own pause: a game ending must not start it again.
    delete entry.job.busy;
    this.update(entry.job, { status: "paused", speed: 0 });
    entry.abort?.abort();
    return true;
  }

  /**
   * Starts a failed or cancelled job again. It resumes from the `.part` file.
   *
   * @param id - Job id.
   * @returns The job, or `undefined` if it does not exist.
   */
  retry(id: string): DownloadJob | undefined {
    const entry = this.jobs.get(id);
    if (!entry) return undefined;
    if (entry.job.status === "failed" || entry.job.status === "cancelled" || entry.job.status === "paused") {
      delete entry.job.error;
      delete entry.job.errorKind;
      this.update(entry.job, { status: "queued", speed: 0 });
      this.pump();
    }
    return { ...entry.job };
  }

  /**
   * Starts a failed, cancelled or paused job again from zero: the `.part` file is deleted first. For a file that
   * changed on the hub, where resuming the old bytes cannot work.
   *
   * @param id - Job id.
   * @returns The job, or `undefined` if it does not exist.
   */
  async restart(id: string): Promise<DownloadJob | undefined> {
    const entry = this.jobs.get(id);
    if (!entry) return undefined;
    if (entry.job.status === "failed" || entry.job.status === "cancelled" || entry.job.status === "paused") {
      await removeParts(`${entry.req.dest}.part`);
      delete entry.job.error;
      delete entry.job.errorKind;
      this.update(entry.job, { status: "queued", speed: 0, received: 0 });
      this.pump();
    }
    return { ...entry.job };
  }

  /**
   * Moves a waiting job in the queue. Only queued jobs have a place; the others are not touched.
   *
   * @param id - Job id.
   * @param to - `"top"` (next to start), `"up"` or `"down"` (one place), or a place in the line (0 is first).
   * @returns `true` if the job is queued and now stands where asked.
   */
  move(id: string, to: QueueMove): boolean {
    const entries = [...this.jobs.values()];
    const slots = entries.flatMap((e, i) => (e.job.status === "queued" ? [i] : []));
    const from = slots.findIndex((i) => entries[i]!.job.id === id);
    if (from < 0) return false;
    const target = to === "top" ? 0 : to === "up" ? from - 1 : to === "down" ? from + 1 : to;
    if (!Number.isInteger(target)) return false;
    const at = Math.min(slots.length - 1, Math.max(0, target));
    if (at === from) return true;
    // Only the queued jobs swap places among the slots they already hold, so finished ones keep their order.
    const queued = slots.map((i) => entries[i]!);
    const [moved] = queued.splice(from, 1);
    queued.splice(at, 0, moved!);
    slots.forEach((slot, n) => (entries[slot] = queued[n]!));
    this.jobs.clear();
    for (const e of entries) this.jobs.set(e.job.id, e);
    this.renumber();
    return true;
  }

  /**
   * Pauses every queued and running job (the `.part` files are kept).
   *
   * @returns How many were paused.
   */
  pauseAll(): number {
    return [...this.jobs.keys()].filter((id) => this.pause(id)).length;
  }

  /**
   * Starts every paused job again, in their old order.
   *
   * @returns How many were resumed.
   */
  resumeAll(): number {
    let n = 0;
    for (const { job } of [...this.jobs.values()]) {
      if (job.status === "paused") {
        this.retry(job.id);
        n++;
      }
    }
    return n;
  }

  /**
   * Removes a finished, failed or cancelled job from the list.
   *
   * @param id - Job id.
   * @returns `true` if it was removed.
   */
  dismiss(id: string): boolean {
    const entry = this.jobs.get(id);
    if (!entry || entry.job.status === "downloading" || entry.job.status === "verifying" || entry.job.status === "queued") return false;
    this.jobs.delete(id);
    return true;
  }

  /** What this job does about the busy PC now (see {@link busyMode}). */
  private modeOf(job: DownloadJob): BusyMode {
    return busyMode(this.busySource(), { enabled: this.slowWhenBusy }, job.dontSlow);
  }

  /**
   * The speed limit for one job (bytes per second, 0: none): its share of the user's limit, which is cut to the
   * "busy" share while the chat answers. Read for every chunk, so a change applies at once.
   */
  private jobLimit(job: DownloadJob): number {
    const total = this.modeOf(job) === "slowed" ? slowedLimit(this.limit, this.peak, this.busyShare) : this.limit;
    return total / Math.max(1, this.active);
  }

  /**
   * Counts the bytes of one job (a stream, all its parts, or a repair) into its progress, a smoothed speed and the
   * time left, once a second. The best combined speed seen while nothing slowed the downloads is remembered as
   * "full speed" for the busy share.
   *
   * @returns The function to call with every chunk's size.
   */
  private counter(job: DownloadJob): (n: number) => void {
    const meter = new RateMeter();
    let windowBytes = 0;
    let windowStart = Date.now();
    return (n) => {
      job.received += n;
      windowBytes += n;
      const elapsed = Date.now() - windowStart;
      if (elapsed < 1000) return;
      const speed = meter.add(windowBytes, elapsed);
      const left = job.total !== undefined ? secondsLeft(job.total - job.received, speed) : undefined;
      if (left === undefined) delete job.etaSeconds;
      this.update(job, { speed, ...(left !== undefined ? { etaSeconds: left } : {}) });
      if (this.modeOf(job) === "none") {
        const all = [...this.jobs.values()].reduce((sum, e) => sum + (e.job.status === "downloading" ? e.job.speed : 0), 0);
        this.peak = Math.max(this.peak, all);
      }
      windowBytes = 0;
      windowStart = Date.now();
    };
  }

  /**
   * Looks at what keeps the PC busy and applies it: downloads that run get their "slowed" badge (the speed itself is
   * cut per chunk), a game in Play pauses the running ones and holds the waiting ones, and when it ends the ones it
   * paused start again by themselves. A download the user paused stays paused. Call it when the state may have
   * changed (the server does it every second); it is cheap when nothing changed.
   */
  refreshBusy(): void {
    for (const entry of [...this.jobs.values()]) {
      const { job } = entry;
      const mode = this.modeOf(job);
      if (entry.checking) continue;
      if (job.status === "downloading") {
        if (mode === "paused") {
          this.update(job, { status: "paused", speed: 0, busy: "paused" });
          delete job.etaSeconds;
          entry.abort?.abort();
        } else this.setBusy(job, mode === "slowed" ? "slowed" : undefined);
      } else if (job.status === "paused" && job.busy === "paused") {
        if (mode !== "paused") {
          delete job.busy;
          this.update(job, { status: "queued", speed: 0 });
        }
      } else if (job.status === "queued") {
        this.setBusy(job, mode === "paused" ? "paused" : undefined);
      } else if (job.busy) this.setBusy(job, undefined);
    }
    this.pump();
  }

  private setBusy(job: DownloadJob, busy: DownloadJob["busy"]): void {
    if (job.busy === busy) return;
    if (busy) this.update(job, { busy });
    else {
      delete job.busy;
      this.update(job, {});
    }
  }

  /**
   * Marks a download "Don't slow": it runs at full speed and never pauses for the chat or a game. Turning it off
   * puts it back under the rules.
   *
   * @param id - Job id.
   * @param on - The mark.
   * @returns `true` if the job exists.
   */
  setDontSlow(id: string, on: boolean): boolean {
    const entry = this.jobs.get(id);
    if (!entry) return false;
    if (on) this.update(entry.job, { dontSlow: true });
    else {
      delete entry.job.dontSlow;
      this.update(entry.job, {});
    }
    this.refreshBusy();
    return true;
  }

  /**
   * One job's snapshot.
   *
   * @param id - Job id.
   * @returns The job, or `undefined` when it does not exist.
   */
  get(id: string): DownloadJob | undefined {
    const entry = this.jobs.get(id);
    return entry ? { ...entry.job } : undefined;
  }

  /** @returns Which Hugging Face file a job is (for fetching its hash again), when it was started from the hub. */
  hubOf(id: string): { repo: string; path: string } | undefined {
    return this.jobs.get(id)?.req.hub;
  }

  /**
   * Checks a finished file against the hub's SHA-256: the file is read once (the `verifying` phase shows the
   * progress) and the job ends `done` with `integrity` `ok` or `bad`. A bad file offers {@link repair}.
   *
   * @param id - Job id; the job must be `done`.
   * @param resolveHash - Fetches the hash when the job has none (an old job); called once.
   * @returns The job as it starts checking, `"no-hash"` when the hub gave no hash, `"busy"` when the job is not a
   * finished one, or `undefined` when it does not exist.
   */
  async verify(id: string, resolveHash?: () => Promise<string | undefined>): Promise<DownloadJob | "no-hash" | "busy" | undefined> {
    const entry = this.jobs.get(id);
    if (!entry) return undefined;
    if (entry.job.status !== "done" || entry.checking) return "busy";
    entry.checking = true;
    let expected = entry.job.sha256;
    try {
      expected ??= await resolveHash?.().catch(() => undefined);
    } finally {
      if (!expected) entry.checking = false;
    }
    if (!expected) return "no-hash";
    entry.req.sha256 = expected;
    this.update(entry.job, { sha256: expected, status: "verifying", speed: 0, verified: 0 });
    void this.check(entry, expected);
    return { ...entry.job };
  }

  /** One pass over the finished file: ok, or bad with the plan for Repair. */
  private async check(entry: Entry, expected: string): Promise<void> {
    const { job, req } = entry;
    const ctrl = new AbortController();
    entry.abort = ctrl;
    try {
      const size = (await stat(req.dest)).size;
      let lastTick = 0;
      const scan = await scanFile(req.dest, {
        signal: ctrl.signal,
        blockSize: this.scanBlock,
        onProgress: (bytes) => {
          // A few updates a second are enough for a progress bar.
          if (Date.now() - lastTick < 250) return;
          lastTick = Date.now();
          this.update(job, { verified: bytes });
        },
      });
      delete job.verified;
      if (hashesMatch(scan.sha256, expected)) {
        delete job.repair;
        delete entry.plan;
        this.update(job, { status: "done", integrity: "ok" });
        return;
      }
      // A file of the wrong length has no holes to find: it is downloaded again whole.
      entry.plan = job.total !== undefined && size !== job.total ? { kind: "whole" } : planRepair(scan.zeroBlocks, size, entry.layout, this.scanBlock);
      this.update(job, { status: "done", integrity: "bad", repair: entry.plan.kind });
    } catch (err) {
      delete job.verified;
      if (ctrl.signal.aborted) {
        this.update(job, { status: "done" });
        return;
      }
      const reason = (err as Error).message;
      this.update(job, { status: "failed", speed: 0, error: reason, errorKind: classifyDownloadError(reason) });
    } finally {
      entry.checking = false;
      delete entry.abort;
    }
  }

  /**
   * Fixes a file that {@link verify} found different from the hub's: when it was downloaded in parts and only some
   * ranges are broken (holes), only those ranges are fetched into the file and it is checked again; otherwise the
   * file is deleted and downloaded again whole (queued like any download, and checked at the end).
   *
   * @param id - Job id; the job must be `done` with `integrity` `bad`.
   * @returns The job, `"not-bad"` when there is nothing to repair, or `undefined` when it does not exist.
   */
  async repair(id: string): Promise<DownloadJob | "not-bad" | undefined> {
    const entry = this.jobs.get(id);
    if (!entry) return undefined;
    const { job, req } = entry;
    if (job.status !== "done" || job.integrity !== "bad" || entry.checking) return "not-bad";
    const plan = entry.plan ?? { kind: "whole" as const };
    if (plan.kind === "ranges") {
      entry.checking = true;
      void this.repairRanges(entry, plan.ranges, plan.bytes);
      return { ...job };
    }
    await Promise.all([unlink(req.dest), removeParts(`${req.dest}.part`)].map((p) => p.catch(() => undefined)));
    delete job.integrity;
    delete job.repair;
    delete entry.plan;
    delete entry.layout;
    entry.verifyNext = true;
    this.update(job, { status: "queued", speed: 0, received: 0 });
    this.pump();
    return { ...job };
  }

  /** Fetches only the broken ranges into the finished file, then checks the whole file again. */
  private async repairRanges(entry: Entry, ranges: ByteRange[], bytes: number): Promise<void> {
    const { job, req } = entry;
    const total = job.total ?? (await stat(req.dest)).size;
    const ctrl = new AbortController();
    entry.abort = ctrl;
    const restoreBad = (patch: Partial<DownloadJob> = {}) => this.update(job, { status: "done", integrity: "bad", repair: "whole", speed: 0, repairing: false, ...patch });
    try {
      delete job.integrity;
      this.update(job, { status: "downloading", repairing: true, repair: "ranges", received: total - bytes, speed: 0 });
      delete job.etaSeconds;
      const state = { size: total, parts: ranges.map((r) => ({ start: r.start, end: r.end, done: 0 })) };
      await downloadParts({ url: req.url, headers: req.headers, file: req.dest, state, signal: ctrl.signal, onBytes: this.counter(job), limit: () => this.jobLimit(job), backoffMs: this.partBackoffMs, persist: false });
      if (ctrl.signal.aborted) {
        // Stopped by the user: the file is as it was, still bad, and Repair can run again.
        this.update(job, { status: "done", integrity: "bad", repair: "ranges", speed: 0, repairing: false });
        return;
      }
      this.update(job, { status: "verifying", speed: 0, verified: 0, repairing: false });
      let lastTick = 0;
      const scan = await scanFile(req.dest, { signal: ctrl.signal, blockSize: this.scanBlock, onProgress: (n) => {
        if (Date.now() - lastTick < 250) return;
        lastTick = Date.now();
        this.update(job, { verified: n });
      } });
      delete job.verified;
      if (hashesMatch(scan.sha256, req.sha256 ?? "")) {
        delete job.repair;
        delete entry.plan;
        this.update(job, { status: "done", integrity: "ok" });
      } else {
        // The ranges did not fix it: the next Repair downloads the whole file.
        entry.plan = { kind: "whole" };
        restoreBad();
      }
    } catch (err) {
      delete job.verified;
      if (ctrl.signal.aborted) return void this.update(job, { status: "done", integrity: "bad", repair: "ranges", speed: 0, repairing: false });
      if (err instanceof RangesRefused) {
        entry.plan = { kind: "whole" };
        restoreBad();
        return;
      }
      const reason = (err as Error).message;
      delete job.repairing;
      this.update(job, { status: "failed", speed: 0, error: reason, errorKind: classifyDownloadError(reason) });
    } finally {
      entry.checking = false;
      delete entry.abort;
    }
  }

  private update(job: DownloadJob, patch: Partial<DownloadJob>): void {
    Object.assign(job, patch);
    if ("status" in patch) this.renumber(job);
    this.emit("update", { ...job });
  }

  /**
   * Gives every queued job its place in the line (1, 2, 3…) and takes it off the others. A job whose place changed
   * is announced, except `skip`, which the caller announces itself.
   */
  private renumber(skip?: DownloadJob): void {
    let n = 0;
    for (const { job } of this.jobs.values()) {
      const place = job.status === "queued" ? ++n : undefined;
      if (job.position === place) continue;
      if (place === undefined) delete job.position;
      else job.position = place;
      if (job !== skip) this.emit("update", { ...job });
    }
  }

  private pump(): void {
    for (const entry of this.jobs.values()) {
      if (this.active >= this.concurrency) return;
      if (entry.job.status !== "queued") continue;
      // A game is in Play: waiting jobs stay in the line until it ends (refreshBusy starts them again).
      if (this.modeOf(entry.job) === "paused") continue;
      this.active++;
      // Taken out of the line at once (not when its first file check ends), so the queue never shows a job that has begun.
      this.update(entry.job, { status: "downloading" });
      this.run(entry).finally(() => {
        this.active--;
        this.pump();
      });
    }
  }

  private async run(entry: Entry): Promise<void> {
    const { job, req } = entry;
    const part = `${req.dest}.part`;
    const ctrl = new AbortController();
    entry.abort = ctrl;
    let diskFull = false;
    try {
      await mkdir(dirname(req.dest), { recursive: true });
      const room = (need: number): Promise<void> => this.ensureRoom(dirname(req.dest), need, () => {
        diskFull = true;
        ctrl.abort();
      });
      delete job.etaSeconds;
      delete job.verified;

      // Speed and time left: the bytes of one stream, or of all parts together.
      const onBytes = this.counter(job);
      // The speed limit is shared by the whole job (one stream or all its parts).
      const pacer = new Pacer();
      const currentLimit = () => this.jobLimit(job);

      const viaParts = await this.runParts(entry, part, ctrl, room, onBytes, currentLimit);
      if (viaParts === "stopped") return;
      if (viaParts === "single") {
        const existing = await stat(part).then((s) => s.size).catch(() => 0);
        const headers: Record<string, string> = { ...req.headers, ...(existing > 0 ? { range: `bytes=${existing}-` } : {}) };
        this.update(job, { received: existing });

        const res = await fetchRetrying(req.url, { headers, signal: entry.abort.signal, redirect: "follow" });
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} ${res.statusText}`);

        // 206 = the server honoured the Range header; anything else restarts from zero.
        const resumed = res.status === 206 && existing > 0;
        const start = resumed ? existing : 0;
        const length = Number(res.headers.get("content-length") ?? NaN);
        if (job.total === undefined && Number.isFinite(length)) job.total = start + length;
        this.update(job, { received: start });
        // Enough room on the disk? Stop now with a clear message instead of failing near the end.
        await room((job.total ?? 0) - start);

        const body = Readable.fromWeb(res.body as import("node:stream/web").ReadableStream<Uint8Array>);
        body.on("data", (chunk: Buffer) => onBytes(chunk.length));
        // The speed limit: wait before taking more when ahead of it (checked per chunk, so a change applies at once).
        const throttle = new Transform({
          transform: (chunk: Buffer, _enc, done) => {
            const wait = pacer.delay(chunk.length, currentLimit());
            if (wait > 0) setTimeout(() => done(null, chunk), wait);
            else done(null, chunk);
          },
        });
        await pipeline(body, throttle, createWriteStream(part, { flags: resumed ? "a" : "w" }));
      }

      let checked = false;
      // Files up to 1 GB are always checked; bigger ones when the setting is on (or when this download repairs a bad file).
      if (req.sha256 && ((job.total ?? job.received) <= AUTO_VERIFY_BYTES || this.verifyBig || entry.verifyNext)) {
        delete job.etaSeconds;
        this.update(job, { status: "verifying", speed: 0, verified: 0 });
        let lastTick = 0;
        const actual = await sha256File(part, (bytes) => {
          // A few updates a second are enough for a progress bar.
          if (Date.now() - lastTick < 250) return;
          lastTick = Date.now();
          this.update(job, { verified: bytes });
        });
        if (actual.toLowerCase() !== req.sha256.toLowerCase()) {
          await removeParts(part);
          throw new Error(`SHA-256 mismatch: expected ${req.sha256}, got ${actual}`);
        }
        checked = true;
      }
      await rename(part, req.dest);
      await unlink(partsFilePath(part)).catch(() => undefined);
      delete job.etaSeconds;
      delete job.verified;
      delete job.busy;
      delete job.repair;
      delete job.repairing;
      delete job.integrity;
      delete entry.verifyNext;
      this.update(job, { status: "done", speed: 0, received: job.total ?? job.received, ...(checked ? { integrity: "ok" as const } : {}) });
    } catch (err) {
      // Stopped on purpose (pause or cancel), even if it was resumed since: not a failure.
      if ((ctrl.signal.aborted && !diskFull) || job.status === "cancelled" || job.status === "paused") return;
      // Node reports network problems as "fetch failed" with the real reason in `cause`.
      const e = err as Error & { code?: string; cause?: { code?: string; message?: string } };
      const reason = e.message === "fetch failed" || e.message === "terminated" ? `${e.message}: ${e.cause?.code ?? e.cause?.message ?? "network error"}` : (e.message ?? String(err));
      delete job.etaSeconds;
      delete job.verified;
      delete job.busy;
      delete job.repairing;
      this.update(job, { status: "failed", speed: 0, error: reason, errorKind: classifyDownloadError(`${reason} ${e.code ?? ""}`.trim()) });
    }
  }

  /**
   * Fails with a clear message when the drive cannot hold `need` more bytes (plus a margin).
   *
   * @param dir - Folder the file goes to.
   * @param need - Bytes still to download.
   * @param onFull - Called just before the error is thrown (the caller marks the job and stops its requests).
   */
  private async ensureRoom(dir: string, need: number, onFull: () => void): Promise<void> {
    if (!(need > 0)) return;
    const free = await freeSpace(dir);
    // A margin of up to 256 MB (as much as the file itself for small ones: the tests' tiny downloads failed on a
    // full disk because of the fixed margin).
    if (free !== undefined && free < need + Math.min(256 * 1024 ** 2, need)) {
      onFull();
      throw new Error(`Not enough disk space: this needs ${gb(need)}, and only ${gb(free)} is free on that drive. Free up space or choose another models folder, then press Retry.`);
    }
  }

  /**
   * Downloads a big file in parallel range parts, when that applies: the setting allows it (or an earlier run left
   * saved parts), the file is big enough, and the server answers a range request with `206`. The parts are written
   * into one preallocated `.part` file (no joining step, no second copy on the disk, one file handle per part and
   * nothing to rename on Windows), and their offsets are saved beside it so each part resumes alone.
   *
   * @returns `"done"` when the whole file is in the `.part` file, `"stopped"` after a pause or cancel (progress is
   * saved), `"single"` when the caller should download in one stream (no ranges, too small, or the setting is 1).
   */
  private async runParts(
    entry: Entry,
    part: string,
    ctrl: AbortController,
    room: (need: number) => Promise<void>,
    onBytes: (n: number) => void,
    limit: () => number,
  ): Promise<"done" | "stopped" | "single"> {
    const { job, req } = entry;
    const existing = await stat(part).then((s) => s.size).catch(() => 0);
    const hasJson = await stat(partsFilePath(part)).then(() => true, () => false);
    // Saved parts from an earlier run always win over the setting: the file on disk is already laid out in parts.
    let state = hasJson ? await loadParts(part, job.total ?? existing) : undefined;
    if (hasJson && !state) {
      await removeParts(part);
      this.update(job, { received: 0 });
    } else if (!state) {
      // A single-stream `.part` from before is finished the old way; small files and the setting 1 stay single too.
      if (this.parts < 2 || existing > 0) return "single";
      if (job.total !== undefined && job.total < this.parallelMinBytes) return "single";
      const total = await probeRanges(req.url, { headers: req.headers, signal: ctrl.signal }, fetchRetrying);
      if (total === undefined || total < this.parallelMinBytes) return "single";
      job.total = total;
      await room(total);
      state = { size: total, parts: planParts(total, Math.min(8, Math.floor(this.parts))) };
      // The saved parts first, then the file: a crash in between leaves no full-size empty file that looks finished.
      await saveParts(part, state);
      const fh = await open(part, "w");
      try {
        await fh.truncate(total);
      } finally {
        await fh.close();
      }
    }
    if (!state) return "single";
    job.total = state.size;
    // Kept for a later repair: which ranges the file was fetched in.
    entry.layout = state.parts.map(({ start, end }) => ({ start, end }));
    const have = state.parts.reduce((n, p) => n + p.done, 0);
    this.update(job, { received: have });
    try {
      await downloadParts({ url: req.url, headers: req.headers, file: part, state, signal: ctrl.signal, onBytes, limit, backoffMs: this.partBackoffMs });
    } catch (err) {
      if (!(err instanceof RangesRefused)) throw err;
      // A redirect target that refuses ranges: forget the parts and take the whole file in one stream.
      await removeParts(part);
      this.update(job, { received: 0 });
      return "single";
    }
    return ctrl.signal.aborted ? "stopped" : "done";
  }
}

const gb = (b: number) => `${(b / 1024 ** 3).toFixed(b < 10 * 1024 ** 3 ? 1 : 0)} GB`;

/**
 * Free space on the drive that holds a folder (the folder may not exist yet).
 *
 * @param dir - A folder.
 * @returns Bytes free for this user, or undefined when it cannot be told.
 */
export async function freeSpace(dir: string): Promise<number | undefined> {
  let d = dir;
  for (let i = 0; i < 30; i++) {
    try {
      const s = await statfs(d);
      return Number(s.bavail) * Number(s.bsize);
    } catch {
      const up = dirname(d);
      if (up === d) return undefined;
      d = up;
    }
  }
  return undefined;
}

/**
 * Hashes a file with SHA-256 without loading it into memory.
 *
 * @param path - File to hash.
 * @param onProgress - Called after each chunk with the bytes hashed so far (for a progress bar).
 * @returns Lower-case hex digest.
 */
export async function sha256File(path: string, onProgress?: (bytes: number) => void): Promise<string> {
  const hash = createHash("sha256");
  let done = 0;
  for await (const chunk of createReadStream(path) as AsyncIterable<Buffer>) {
    hash.update(chunk);
    done += chunk.length;
    onProgress?.(done);
  }
  return hash.digest("hex");
}

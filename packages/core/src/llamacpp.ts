import { spawn, type ChildProcess } from "node:child_process";
import { chmod, mkdir, readdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import type { DownloadJob, DownloadManager } from "@kesher/downloads";

/** Platform facts that decide which llama.cpp build to download. */
export interface PlatformInfo {
  platform: NodeJS.Platform;
  arch: string;
  /** Whether an NVIDIA GPU was found (then the CUDA build is used). */
  nvidia: boolean;
}

/** The release files to download for this computer. */
export interface LlamaAssets {
  /** The llama.cpp binaries. */
  main: string;
  /** CUDA runtime libraries, needed next to the CUDA build on Windows and Linux. */
  runtime?: string;
  /** Human description, e.g. "Windows, CUDA 12". */
  label: string;
}

/**
 * Picks the llama.cpp release files for a platform. Release file names look
 * like `llama-b12110-bin-win-cuda-12.4-x64.zip`; matching ignores the build
 * number so new releases keep working.
 *
 * CUDA 12 is preferred over 13 on NVIDIA because it works with older drivers.
 * Without NVIDIA, Windows gets the Vulkan build (any GPU, falls back to CPU),
 * Linux the CPU build, macOS the Metal build.
 *
 * @param names - Asset file names of the release.
 * @param p - Platform facts.
 * @returns The files, or `undefined` if the platform has no build.
 */
export function pickLlamaAssets(names: string[], p: PlatformInfo): LlamaAssets | undefined {
  const find = (re: RegExp) => names.find((n) => re.test(n));
  const arch = p.arch === "arm64" ? "arm64" : "x64";
  const cuda = (os: "win" | "ubuntu") => {
    for (const major of ["12", "13"]) {
      const main = find(new RegExp(`^llama-b\\d+-bin-${os}-cuda-(${major}\\.[\\d.]+)-${arch}\\.(zip|tar\\.gz)$`));
      if (!main) continue;
      const version = /cuda-([\d.]+)-/.exec(main)?.[1] ?? "";
      const runtime = find(new RegExp(`^cudart-llama-(b\\d+-)?bin-${os}-cuda-${version.replace(/\./g, "\\.")}-${arch}\\.(zip|tar\\.gz)$`));
      return { main, ...(runtime ? { runtime } : {}), label: `CUDA ${version}` };
    }
    return undefined;
  };
  if (p.platform === "win32") {
    if (p.nvidia) {
      const c = cuda("win");
      if (c) return { ...c, label: `Windows, NVIDIA ${c.label}` };
    }
    const vulkan = find(new RegExp(`^llama-b\\d+-bin-win-vulkan-${arch}\\.zip$`));
    if (vulkan) return { main: vulkan, label: "Windows, Vulkan (any GPU)" };
    const cpu = find(new RegExp(`^llama-b\\d+-bin-win-cpu-${arch}\\.zip$`));
    return cpu ? { main: cpu, label: "Windows, CPU" } : undefined;
  }
  if (p.platform === "darwin") {
    const mac = find(new RegExp(`^llama-b\\d+-bin-macos-${arch}\\.(zip|tar\\.gz)$`));
    return mac ? { main: mac, label: `macOS ${arch === "arm64" ? "Apple Silicon (Metal)" : "Intel"}` } : undefined;
  }
  if (p.platform === "linux") {
    if (p.nvidia) {
      const c = cuda("ubuntu");
      if (c) return { ...c, label: `Linux, NVIDIA ${c.label}` };
    }
    const cpu = find(new RegExp(`^llama-b\\d+-bin-ubuntu-${arch}\\.(zip|tar\\.gz)$`));
    return cpu ? { main: cpu, label: "Linux, CPU" } : undefined;
  }
  return undefined;
}

/** A GitHub release as far as the installer cares. */
interface Release {
  tag_name: string;
  body?: string;
  assets: Array<{ name: string; browser_download_url: string; size: number }>;
}

const GITHUB = "https://api.github.com/repos/ggml-org/llama.cpp/releases";

/**
 * Finds the newest llama.cpp release that has binaries. Stable releases
 * (`v0.9.0`) link to the nightly build (`b12110`) that carries the files;
 * older releases carry the files themselves.
 *
 * @param signal - Abort signal.
 * @returns The release with binaries.
 */
export async function findLlamaRelease(signal?: AbortSignal): Promise<Release> {
  const headers = { accept: "application/vnd.github+json", "user-agent": "KesherAI" };
  const get = async (url: string) => {
    const res = await fetch(url, { headers, signal });
    if (!res.ok) throw new Error(`GitHub answered ${res.status} for ${url}`);
    return (await res.json()) as Release;
  };
  const latest = await get(`${GITHUB}/latest`);
  if (latest.assets.some((a) => a.name.includes("-bin-"))) return latest;
  const nightly = /Nightly build:\*?\*?\s*\[(b\d+)\]/i.exec(latest.body ?? "")?.[1];
  if (nightly) return get(`${GITHUB}/tags/${nightly}`);
  const recent = (await (await fetch(`${GITHUB}?per_page=10`, { headers, signal })).json()) as Release[];
  const withBins = recent.find((r) => r.assets.some((a) => a.name.includes("-bin-")));
  if (!withBins) throw new Error("Could not find a llama.cpp release with downloadable binaries");
  return withBins;
}

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { windowsHide: true, stdio: "ignore" });
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited with ${code}`))));
  });
}

/**
 * Unpacks a `.zip` or `.tar.gz`. Uses `tar`, which ships with Windows 10+,
 * macOS and Linux (and reads zip files on Windows and macOS); falls back to
 * `unzip` for zip files on Linux.
 *
 * @param archive - File to unpack.
 * @param dest - Target folder (created).
 */
export async function extractArchive(archive: string, dest: string): Promise<void> {
  await mkdir(dest, { recursive: true });
  try {
    await run("tar", ["-xf", archive, "-C", dest]);
  } catch (err) {
    if (!archive.endsWith(".zip")) throw err;
    await run("unzip", ["-o", "-q", archive, "-d", dest]);
  }
}

async function findFile(dir: string, name: string): Promise<string | undefined> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isFile() && e.name.toLowerCase() === name.toLowerCase()) return full;
    if (e.isDirectory()) {
      const found = await findFile(full, name);
      if (found) return found;
    }
  }
  return undefined;
}

/**
 * Waits for a download job to finish.
 *
 * @param dm - The download manager.
 * @param id - Job id.
 * @returns The finished job.
 * @throws Error if it failed or was cancelled.
 */
export function waitForDownload(dm: DownloadManager, id: string): Promise<DownloadJob> {
  return new Promise((resolve, reject) => {
    const on = (job: DownloadJob) => {
      if (job.id !== id) return;
      if (job.status === "done") {
        dm.off("update", on);
        resolve(job);
      } else if (job.status === "failed" || job.status === "cancelled") {
        dm.off("update", on);
        reject(new Error(job.error ?? `Download ${job.status}`));
      }
    };
    dm.on("update", on);
  });
}

/** What the UI shows about the built-in engine. */
export interface EngineStatus {
  installed: boolean;
  /** llama.cpp build installed, e.g. `b12110`. */
  version?: string;
  binaryPath?: string;
  running: boolean;
  /** GGUF file loaded. */
  modelPath?: string;
  /** What the engine is busy with, if anything. */
  job?: { phase: "installing" | "downloading-model" | "loading"; message: string } | { phase: "error"; message: string };
  /** Last lines of llama-server's output. */
  log: string[];
}

/**
 * KesherAI's built-in local engine: installs llama.cpp's `llama-server`
 * from the official GitHub releases (no LM Studio or Ollama needed), then
 * starts and stops it for one GGUF model at a time. The running server is
 * registered as the `llamacpp` provider by the core server.
 */
export class LlamaEngine {
  private proc?: ChildProcess;
  private modelPath?: string;
  private readonly log: string[] = [];
  private job?: EngineStatus["job"];

  /**
   * @param opts.dir - Folder engines are installed into.
   * @param opts.binaryPath - An already installed `llama-server`, if any.
   * @param opts.version - Its build tag.
   * @param opts.port - Port to serve on (localhost only).
   * @param opts.args - Extra arguments from the config.
   */
  constructor(
    private readonly opts: { dir: string; binaryPath?: string; version?: string; port: number; args: string[] },
  ) {}

  /** @returns The engine's state. */
  status(): EngineStatus {
    const installed = !!this.opts.binaryPath && existsSync(this.opts.binaryPath);
    return {
      installed,
      ...(this.opts.version ? { version: this.opts.version } : {}),
      ...(installed ? { binaryPath: this.opts.binaryPath } : {}),
      running: !!this.proc && this.proc.exitCode === null,
      ...(this.modelPath ? { modelPath: this.modelPath } : {}),
      ...(this.job ? { job: this.job } : {}),
      log: this.log.slice(-60),
    };
  }

  /** @returns The OpenAI-compatible base URL of the running server. */
  get baseUrl(): string {
    return `http://127.0.0.1:${this.opts.port}/v1`;
  }

  /**
   * Shows progress in {@link status} while `work` runs; leaves an error
   * message there if it fails.
   *
   * @param phase - What is happening.
   * @param message - Shown to the user.
   * @param work - The work.
   * @returns What `work` returns.
   */
  async track<T>(phase: "installing" | "downloading-model" | "loading", message: string, work: () => Promise<T>): Promise<T> {
    this.job = { phase, message };
    try {
      const result = await work();
      this.job = undefined;
      return result;
    } catch (err) {
      this.job = { phase: "error", message: err instanceof Error ? err.message : String(err) };
      throw err;
    }
  }

  /**
   * Shows an error in {@link status} (for work done outside {@link track}).
   *
   * @param err - What went wrong.
   */
  fail(err: unknown): void {
    this.job = { phase: "error", message: err instanceof Error ? err.message : String(err) };
  }

  /**
   * Downloads and unpacks the right llama.cpp build for this computer.
   *
   * @param downloads - Where the download shows progress.
   * @param platform - Platform facts.
   * @returns The installed binary and its version.
   */
  async install(downloads: DownloadManager, platform: PlatformInfo): Promise<{ binaryPath: string; version: string }> {
    return this.track("installing", "Finding the latest llama.cpp release…", async () => {
      const release = await findLlamaRelease();
      const picked = pickLlamaAssets(release.assets.map((a) => a.name), platform);
      if (!picked) throw new Error(`llama.cpp has no ready-made build for ${platform.platform}/${platform.arch}`);
      const target = join(this.opts.dir, "llama.cpp", release.tag_name);
      await rm(target, { recursive: true, force: true });
      for (const name of [picked.main, picked.runtime].filter((n): n is string => !!n)) {
        const asset = release.assets.find((a) => a.name === name)!;
        this.job = { phase: "installing", message: `Downloading llama.cpp ${release.tag_name} (${picked.label})…` };
        const archive = join(this.opts.dir, "downloads", name);
        const job = downloads.enqueue({ url: asset.browser_download_url, dest: archive, size: asset.size, label: `llama.cpp · ${name}` });
        await waitForDownload(downloads, job.id);
        this.job = { phase: "installing", message: "Unpacking…" };
        await extractArchive(archive, target);
        await rm(archive, { force: true });
      }
      const exe = process.platform === "win32" ? "llama-server.exe" : "llama-server";
      const binaryPath = await findFile(target, exe);
      if (!binaryPath) throw new Error(`The download did not contain ${exe}`);
      if (process.platform !== "win32") await chmod(binaryPath, 0o755);
      this.opts.binaryPath = binaryPath;
      this.opts.version = release.tag_name;
      return { binaryPath, version: release.tag_name };
    });
  }

  /**
   * The arguments llama-server gets: the config's, plus `--jinja` (needed
   * for tool calling) and a 16k context unless the config sets its own.
   *
   * @param extra - Arguments from the config.
   * @param withJinja - Whether to add `--jinja`.
   * @returns The full argument list besides model, host and port.
   */
  static serverArgs(extra: string[], withJinja = true): string[] {
    const args = [...extra];
    if (withJinja && !args.includes("--jinja")) args.push("--jinja");
    if (!args.some((a) => a === "-c" || a === "--ctx-size")) args.push("-c", "16384");
    return args;
  }

  /**
   * Starts llama-server with a model and waits until it answers.
   *
   * @param modelPath - Absolute path of a `.gguf` file.
   * @param timeoutMs - How long loading may take.
   * @throws Error if the engine is not installed, or the server exits or does not become ready.
   */
  async load(modelPath: string, timeoutMs = 300_000): Promise<void> {
    const binary = this.opts.binaryPath;
    if (!binary || !existsSync(binary)) throw new Error("The llama.cpp engine is not installed yet. Install it from the Models screen.");
    await this.track("loading", `Loading ${basename(modelPath)}…`, async () => {
      try {
        await this.start(binary, modelPath, LlamaEngine.serverArgs(this.opts.args, true), timeoutMs);
      } catch (err) {
        // Builds that predate --jinja (or where it became the default and the flag was removed) reject it.
        if (!/jinja/i.test(this.log.join("\n"))) throw err;
        await this.start(binary, modelPath, LlamaEngine.serverArgs(this.opts.args, false), timeoutMs);
      }
    });
  }

  private async start(binary: string, modelPath: string, args: string[], timeoutMs: number): Promise<void> {
    await this.stop();
    this.log.length = 0;
    const alias = basename(modelPath).replace(/\.gguf$/i, "");
    const proc = spawn(binary, ["-m", modelPath, "--host", "127.0.0.1", "--port", String(this.opts.port), "--alias", alias, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    this.proc = proc;
    this.modelPath = modelPath;
    const onData = (buf: Buffer) => {
      this.log.push(...buf.toString().split(/\r?\n/).filter(Boolean));
      if (this.log.length > 300) this.log.splice(0, this.log.length - 300);
    };
    proc.stdout?.on("data", onData);
    proc.stderr?.on("data", onData);
    const spawnError = new Promise<never>((_, reject) => proc.once("error", reject));

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (proc.exitCode !== null) {
        this.proc = undefined;
        this.modelPath = undefined;
        throw new Error(`llama-server stopped (code ${proc.exitCode}): ${this.log.slice(-4).join(" | ")}`);
      }
      const ok = await Promise.race([
        fetch(`http://127.0.0.1:${this.opts.port}/health`).then((r) => r.ok).catch(() => false),
        spawnError,
      ]);
      if (ok) return;
      await new Promise((r) => setTimeout(r, 500));
    }
    await this.stop();
    throw new Error("llama-server did not become ready in time");
  }

  /** Stops the server if it runs. */
  async stop(): Promise<void> {
    const proc = this.proc;
    this.proc = undefined;
    this.modelPath = undefined;
    if (!proc || proc.exitCode !== null) return;
    proc.kill();
    await new Promise((r) => {
      const t = setTimeout(() => {
        proc.kill("SIGKILL");
        r(undefined);
      }, 5000);
      proc.once("exit", () => {
        clearTimeout(t);
        r(undefined);
      });
    });
  }
}

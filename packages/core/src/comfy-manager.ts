import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DownloadManager } from "@kesher/downloads";
import { extractArchive, waitForDownload } from "./llamacpp.js";
import type { Runtimes } from "./runtimes.js";

/**
 * Managed ComfyUI: KesherAI installs ComfyUI (its source from GitHub, and
 * Python with PyTorch through uv), starts and stops it, and registers it as
 * an image engine — or runs a ComfyUI the user already has (a portable
 * Windows copy or a folder with main.py). Its checkpoints folder includes
 * KesherAI's models folder.
 *
 * Downloads go through the download queue; the user starts them from the
 * Models page.
 */

/** What the manager is doing. */
export interface ComfyStatus {
  installed: boolean;
  /** The ComfyUI folder in use. */
  folder?: string;
  /** Whether it is KesherAI's own copy. */
  managed: boolean;
  running: boolean;
  url: string;
  phase?: "installing" | "starting" | "error";
  message?: string;
  log: string[];
}

const run = (cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; onLine?: (l: string) => void } = {}) =>
  new Promise<void>((ok, fail) => {
    const p = spawn(cmd, args, { cwd: opts.cwd, env: opts.env, windowsHide: true });
    const line = (d: Buffer) => d.toString().split(/\r?\n/).filter(Boolean).forEach((l) => opts.onLine?.(l));
    p.stdout.on("data", line);
    p.stderr.on("data", line);
    p.on("error", fail);
    p.on("exit", (code) => (code === 0 ? ok() : fail(new Error(`${cmd} exited with ${code}`))));
  });

/** Starts, stops and installs ComfyUI. */
export class ComfyManager {
  private child?: ChildProcess;
  private phase?: ComfyStatus["phase"];
  private message?: string;
  private readonly log: string[] = [];
  private busy?: Promise<void>;

  /**
   * @param dir - engines/comfyui.
   * @param opts - Settings, downloads, runtimes, models folder, GPU, and what to do when it is up.
   */
  constructor(
    private readonly dir: string,
    private readonly opts: {
      downloads: DownloadManager;
      runtimes: Runtimes;
      modelsDir: () => string;
      port: () => number;
      /** The user's own ComfyUI, if chosen. */
      folder: () => string | undefined;
      nvidia: () => Promise<boolean>;
      onReady: (url: string) => void;
    },
  ) {}

  private get ownFolder() {
    return join(this.dir, "ComfyUI");
  }

  private folder(): string | undefined {
    const own = this.opts.folder();
    if (own && existsSync(own)) return own;
    return existsSync(join(this.ownFolder, "main.py")) ? this.ownFolder : undefined;
  }

  private add(line: string) {
    this.log.push(line.slice(0, 400));
    if (this.log.length > 200) this.log.splice(0, this.log.length - 200);
  }

  /** @returns Its state. */
  status(): ComfyStatus {
    const folder = this.folder();
    return {
      installed: !!folder,
      ...(folder ? { folder } : {}),
      managed: folder === this.ownFolder,
      running: !!this.child && this.child.exitCode === null,
      url: `http://127.0.0.1:${this.opts.port()}`,
      ...(this.phase ? { phase: this.phase } : {}),
      ...(this.message ? { message: this.message } : {}),
      log: this.log.slice(-40),
    };
  }

  private async python(folder: string): Promise<{ cmd: string; args: string[] }> {
    // A Windows portable copy: ComfyUI_windows_portable\python_embeded + ComfyUI\main.py.
    const portable = [join(folder, "python_embeded", "python.exe"), join(folder, "..", "python_embeded", "python.exe")].find(existsSync);
    const main = existsSync(join(folder, "main.py")) ? join(folder, "main.py") : join(folder, "ComfyUI", "main.py");
    if (portable) return { cmd: portable, args: ["-s", main, "--windows-standalone-build"] };
    const venv = [join(this.dir, "venv"), join(folder, "venv"), join(folder, ".venv")].map((v) => join(v, process.platform === "win32" ? "Scripts/python.exe" : "bin/python")).find(existsSync);
    return { cmd: venv ?? (process.platform === "win32" ? "python" : "python3"), args: [main] };
  }

  /**
   * Installs KesherAI's own ComfyUI: the latest source, Python 3.12 and
   * PyTorch (CUDA on NVIDIA cards) in a virtual environment.
   */
  install(): Promise<void> {
    this.busy ??= (async () => {
      this.phase = "installing";
      try {
        this.message = "Getting uv (Python installer)…";
        await this.opts.runtimes.install("uv");
        const uvDir = (await this.opts.runtimes.paths()).find((p) => existsSync(join(p, process.platform === "win32" ? "uv.exe" : "uv")));
        if (!uvDir) throw new Error("uv was not found after installing it.");
        const uv = join(uvDir, process.platform === "win32" ? "uv.exe" : "uv");
        this.message = "Finding the latest ComfyUI…";
        const rel = await fetch("https://api.github.com/repos/comfyanonymous/ComfyUI/releases/latest", { headers: { accept: "application/vnd.github+json", "user-agent": "KesherAI" }, signal: AbortSignal.timeout(30_000) });
        if (!rel.ok) throw new Error(`GitHub answered ${rel.status} while looking for ComfyUI.`);
        const tag = ((await rel.json()) as { tag_name: string }).tag_name;
        await mkdir(this.dir, { recursive: true });
        const zip = join(this.dir, `ComfyUI-${tag}.zip`);
        const job = this.opts.downloads.enqueue({ url: `https://codeload.github.com/comfyanonymous/ComfyUI/zip/refs/tags/${tag}`, dest: zip, label: `ComfyUI ${tag}` });
        await waitForDownload(this.opts.downloads, job.id);
        const tmp = join(this.dir, "unpack");
        await rm(tmp, { recursive: true, force: true });
        await extractArchive(zip, tmp);
        const inner = (await readdir(tmp)).find((n) => n.toLowerCase().startsWith("comfyui"));
        if (!inner) throw new Error("The ComfyUI download did not contain ComfyUI.");
        await rm(this.ownFolder, { recursive: true, force: true });
        await rename(join(tmp, inner), this.ownFolder);
        await rm(tmp, { recursive: true, force: true });
        await rm(zip, { force: true });
        const venv = join(this.dir, "venv");
        const env = { ...process.env, UV_PYTHON_INSTALL_DIR: join(this.dir, "python"), UV_CACHE_DIR: join(this.dir, "uv-cache") };
        this.message = "Setting up Python 3.12…";
        await run(uv, ["venv", "--python", "3.12", "--seed", venv], { env, onLine: (l) => this.add(l) });
        const py = join(venv, process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
        this.message = "Installing PyTorch (a few GB; this takes a while)…";
        const nvidia = process.platform !== "darwin" && (await this.opts.nvidia().catch(() => false));
        await run(uv, ["pip", "install", "--python", py, "torch", "torchvision", "torchaudio", ...(nvidia ? ["--index-url", "https://download.pytorch.org/whl/cu128"] : process.platform === "darwin" ? [] : ["--index-url", "https://download.pytorch.org/whl/cpu"])], { env, onLine: (l) => this.add(l) });
        this.message = "Installing ComfyUI's packages…";
        await run(uv, ["pip", "install", "--python", py, "-r", join(this.ownFolder, "requirements.txt")], { env, onLine: (l) => this.add(l) });
        this.phase = undefined;
        this.message = "ComfyUI is installed.";
      } catch (e) {
        this.phase = "error";
        this.message = (e as Error).message;
        throw e;
      } finally {
        this.busy = undefined;
      }
    })();
    return this.busy;
  }

  /** Starts ComfyUI and waits until it answers. */
  async start(timeoutMs = 300_000): Promise<void> {
    if (this.status().running) return;
    const folder = this.folder();
    if (!folder) throw new Error("ComfyUI is not installed. Install it, or choose the folder of your own ComfyUI.");
    // Also look for checkpoints in KesherAI's models folder.
    const yaml = join(this.dir, "kesher_model_paths.yaml");
    await mkdir(this.dir, { recursive: true });
    await writeFile(yaml, `kesherai:\n  base_path: ${JSON.stringify(this.opts.modelsDir())}\n  checkpoints: .\n  loras: loras\n  vae: vae\n  diffusion_models: video\n  text_encoders: text_encoders\n`);
    const { cmd, args } = await this.python(folder);
    const nvidia = await this.opts.nvidia().catch(() => false);
    const full = [...args, "--listen", "127.0.0.1", "--port", String(this.opts.port()), "--extra-model-paths-config", yaml, ...(nvidia || process.platform === "darwin" ? [] : ["--cpu"])];
    this.phase = "starting";
    this.message = "Starting ComfyUI…";
    this.add(`> ${cmd} ${full.join(" ")}`);
    const child = spawn(cmd, full, { cwd: existsSync(join(folder, "main.py")) ? folder : join(folder, "ComfyUI"), windowsHide: true, env: { ...process.env, PYTHONUNBUFFERED: "1" } });
    this.child = child;
    const line = (d: Buffer) => d.toString().split(/\r?\n/).filter(Boolean).forEach((l) => this.add(l));
    child.stdout?.on("data", line);
    child.stderr?.on("data", line);
    const exited = new Promise<never>((_, no) => {
      child.on("error", (e) => no(e));
      child.on("exit", (code) => no(new Error(`ComfyUI stopped (exit ${code}). ${this.log.slice(-3).join(" ")}`)));
    });
    exited.catch(() => undefined);
    const end = Date.now() + timeoutMs;
    try {
      while (Date.now() < end) {
        const ok = await Promise.race([fetch(`${this.status().url}/system_stats`, { signal: AbortSignal.timeout(2000) }).then((r) => r.ok, () => false), exited]);
        if (ok) {
          this.phase = undefined;
          this.message = "ComfyUI is running.";
          this.opts.onReady(this.status().url);
          return;
        }
        await new Promise((r) => setTimeout(r, 1000));
      }
      throw new Error("ComfyUI did not start in time.");
    } catch (e) {
      this.phase = "error";
      this.message = (e as Error).message;
      await this.stop();
      throw e;
    }
  }

  /** Stops ComfyUI. */
  async stop(): Promise<void> {
    const c = this.child;
    this.child = undefined;
    if (!c || c.exitCode !== null) return;
    c.kill();
    await new Promise((r) => {
      const t = setTimeout(() => (c.kill("SIGKILL"), r(undefined)), 5000);
      c.once("exit", () => (clearTimeout(t), r(undefined)));
    });
  }
}

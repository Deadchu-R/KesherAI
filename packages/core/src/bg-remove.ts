import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

/**
 * Removing a picture's background (the image editor's "Remove background", as Photoshop's and Canva's): rembg with
 * BiRefNet (MIT), in its own Python, set up when she first asks for it (about 1 GB once: onnxruntime and the model).
 * A picture goes in; the same picture comes out as a PNG with the background clear.
 */

/** What the background remover is doing. */
export interface BgRemoveState {
  installed: boolean;
  phase?: "installing" | "working" | "error";
  message?: string;
  log: string[];
}

/**
 * The models she can pick: BiRefNet (the sharpest edges, hair), a light one that is quicker on the processor, and SAM
 * (Segment Anything, Apache-2.0) for "select the object I tap", which needs a point.
 */
export const BG_MODELS = ["birefnet-general", "birefnet-general-lite", "isnet-general-use", "sam"] as const;

/** Our runner: one picture in, the cut-out PNG out (with the edges of the mask cleaned). */
const RUNNER = `import json, sys
from PIL import Image
from rembg import new_session, remove
a = json.loads(sys.argv[1])
s = new_session(a["model"])
img = Image.open(a["in"]).convert("RGB") if a.get("point") else Image.open(a["in"])
img.load()
kw = {"post_process_mask": True}
if a.get("point"):
    kw["sam_prompt"] = [{"type": "point", "data": a["point"], "label": 1}]
if a.get("mask"):
    kw["only_mask"] = True
remove(img, session=s, **kw).save(a["out"], "PNG")
print("DONE")
`;

/** Sets rembg up once and removes backgrounds with it. */
export class BgRemover {
  private state: BgRemoveState = { installed: false, log: [] };
  private busy?: Promise<unknown>;

  /**
   * @param dir - engines/rembg.
   * @param uv - The path to uv (installs it if needed).
   * @param freeGpuBytes - The most free memory on any graphics card now (the GPU guard's reading), when known.
   */
  constructor(
    private readonly dir: string,
    private readonly uv: () => Promise<string>,
    private readonly freeGpuBytes?: () => number | undefined,
  ) {}

  private get python() {
    return join(this.dir, "venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
  }

  /** @returns Whether it is set up, what it is doing, and the last lines of its log. */
  status(): BgRemoveState {
    return { ...this.state, installed: existsSync(join(this.dir, "runner.py")) && existsSync(this.python), log: this.state.log.slice(-40) };
  }

  private add(line: string) {
    this.state.log.push(line.slice(0, 300));
    if (this.state.log.length > 300) this.state.log.splice(0, 100);
  }

  private get env(): NodeJS.ProcessEnv {
    // The models are kept in the engine's folder, not in the user's home.
    return { ...process.env, UV_PYTHON_INSTALL_DIR: join(this.dir, "python"), UV_CACHE_DIR: join(this.dir, "uv-cache"), U2NET_HOME: join(this.dir, "models"), PYTHONIOENCODING: "utf-8", PYTHONUNBUFFERED: "1" };
  }

  private run(cmd: string, args: string[], timeoutMs = 30 * 60_000): Promise<void> {
    return new Promise((ok, fail) => {
      const p = spawn(cmd, args, { env: this.env, windowsHide: true });
      const on = (b: Buffer) => b.toString().split(/\r?\n/).filter(Boolean).forEach((l) => this.add(l));
      const timer = setTimeout(() => p.kill(), timeoutMs);
      p.stdout.on("data", on);
      p.stderr.on("data", on);
      p.on("error", (e) => (clearTimeout(timer), fail(e)));
      p.on("close", (code) => (clearTimeout(timer), code === 0 ? ok() : fail(new Error(`${cmd.split(/[\\/]/).pop()} stopped (code ${code}); see the log.`))));
    });
  }

  /** Installs Python 3.11, rembg (with the GPU's onnxruntime; it falls back to the processor) and BiRefNet's weights. */
  install(): Promise<unknown> {
    this.busy ??= (async () => {
      Object.assign(this.state, { phase: "installing", message: "Setting up the background remover (about 1 GB, once)…" });
      try {
        const uv = await this.uv();
        await mkdir(this.dir, { recursive: true });
        if (!existsSync(this.python)) await this.run(uv, ["venv", "--python", "3.11", "--seed", join(this.dir, "venv")]);
        await this.run(uv, ["pip", "install", "--python", this.python, "rembg[gpu]", "pillow"]);
        await writeFile(join(this.dir, "runner.py"), RUNNER);
        // A first run on a tiny picture fetches the model now rather than on her first real picture.
        const work = join(this.dir, "work", "warm");
        await mkdir(work, { recursive: true });
        await writeFile(join(work, "in.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"));
        await this.run(this.python, [join(this.dir, "runner.py"), JSON.stringify({ model: BG_MODELS[0], in: join(work, "in.png"), out: join(work, "out.png") })]);
        await rm(work, { recursive: true, force: true });
        Object.assign(this.state, { phase: undefined, message: "Ready." });
      } catch (e) {
        Object.assign(this.state, { phase: "error", message: (e as Error).message });
      } finally {
        this.busy = undefined;
      }
    })();
    return this.busy;
  }

  /**
   * Removes a picture's background.
   *
   * @param picture - A PNG, JPEG or WebP.
   * @param model - One of BG_MODELS (BiRefNet by default).
   * @param opts - point: [x, y] in the picture (SAM needs it); mask: the black-and-white mask instead of the cut-out.
   * @returns The PNG with the background clear (or the mask).
   */
  async remove(picture: Buffer, model: string = BG_MODELS[0], opts: { point?: [number, number]; mask?: boolean } = {}): Promise<Buffer> {
    if (!this.status().installed) throw Object.assign(new Error("Set up the background remover first."), { statusCode: 409 });
    if (this.busy) throw Object.assign(new Error("The background remover is busy; try again in a moment."), { statusCode: 409 });
    // With a model already filling the card (self-work's, a chat's), this would crawl in shared memory for minutes: say so.
    const free = this.freeGpuBytes?.();
    if (free !== undefined && free < 2 * 1024 ** 3) throw Object.assign(new Error(`The graphics card is full (${(free / 1024 ** 3).toFixed(1)} GB free; the background remover needs about 2 GB). Unload the model in Models, or wait for self-work to finish.`), { statusCode: 409, code: "gpu-full" });
    if (!(BG_MODELS as readonly string[]).includes(model)) throw Object.assign(new Error("Unknown model."), { statusCode: 400 });
    if (model === "sam" && !opts.point) throw Object.assign(new Error("Tap a point for Segment Anything."), { statusCode: 400 });
    const point = opts.point && opts.point.every((n) => Number.isInteger(n) && n >= 0 && n < 100_000) ? opts.point : undefined;
    const kind = picture.subarray(0, 4).toString("hex");
    if (!/^(89504e47|ffd8ff..|52494646)$/.test(kind)) throw Object.assign(new Error("Send a PNG, JPEG or WebP picture."), { statusCode: 400 });
    const work = join(this.dir, "work", randomUUID());
    const job = (async () => {
      Object.assign(this.state, { phase: "working", message: "Removing the background…" });
      await mkdir(work, { recursive: true });
      try {
        await writeFile(join(work, "in"), picture);
        await this.run(this.python, [join(this.dir, "runner.py"), JSON.stringify({ model, in: join(work, "in"), out: join(work, "out.png"), ...(point ? { point } : {}), ...(opts.mask ? { mask: true } : {}) })], 5 * 60_000);
        Object.assign(this.state, { phase: undefined, message: "Done." });
        return await readFile(join(work, "out.png"));
      } catch (e) {
        Object.assign(this.state, { phase: "error", message: (e as Error).message });
        throw e;
      } finally {
        await rm(work, { recursive: true, force: true }).catch(() => undefined);
      }
    })();
    this.busy = job.finally(() => (this.busy = undefined));
    return job;
  }
}

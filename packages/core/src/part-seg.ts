import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

/**
 * Splitting a 3D model into parts by meaning (Roee, 2026-11-18: "ask the AI to split it"): P3-SAM, the part segmenter of
 * Tencent's Hunyuan3D-Part (RESEARCH_LOG "Choosing exact parts…"), in its own Python (PyTorch with CUDA, its code from
 * the Hunyuan3D-Part Space and its weights from the model page, a few GB once). A mesh goes in; for every triangle, the
 * part it belongs to comes out, as the triangle's centre and a part number, so the 3D editor can split the mesh it has.
 */

/** What the parts engine is doing. */
export interface PartSegState {
  installed: boolean;
  phase?: "installing" | "working" | "error";
  message?: string;
  log: string[];
}

/**
 * Our own runner around P3-SAM's demo: runs it on one mesh, then writes each face's centre and part as JSON.
 * It runs the demo in this same Python, so it can adjust Sonata (the point backbone) for Windows first: its weights go
 * to our folder instead of Linux's /root/sonata, and without flash-attention (which does not build on Windows) it uses
 * plain attention, the setting Sonata's authors give for that (enable_flash=False, patches of 1024).
 */
const RUNNER = `import glob, json, os, runpy, sys
import numpy as np, trimesh
a = json.loads(sys.argv[1])
p3 = os.path.join(a["code"], "P3-SAM")
demo = os.path.join(p3, "demo")
out = a["out"]
os.makedirs(out, exist_ok=True)
for extra in (os.path.join(a["code"], "XPart", "partgen"), p3, demo):
    if os.path.isdir(extra) and extra not in sys.path:
        sys.path.insert(0, extra)
try:
    from models import sonata
    _load = sonata.load
    def load(*args, **kw):
        kw["download_root"] = a["sonata"]
        try:
            import flash_attn  # noqa: F401
        except ImportError:
            cc = dict(kw.get("custom_config") or {})
            cc.update(enable_flash=False, enc_patch_size=[1024] * 5)
            kw["custom_config"] = cc
        return _load(*args, **kw)
    sonata.load = load
except Exception as e:
    print("sonata not adjusted:", e)
sys.argv = ["auto_mask.py", "--mesh_path", a["mesh"], "--output_path", out, "--parallel", "0", "--post_process", "0", "--clean_mesh", "0", "--save_mid_res", "0", "--show_info", "0", "--show_time_info", "1"]
if a.get("ckpt"):
    sys.argv += ["--ckpt_path", a["ckpt"]]
# Lighter than the demo's defaults (100 000 points, 400 prompts), which filled a 24 GB card and spilled into the
# computer's memory (found on the PC: ten minutes on a small chair). Only the flags this auto_mask.py knows.
src = open(os.path.join(demo, "auto_mask.py"), encoding="utf-8").read()
for flag, value in (("--point_num", "30000"), ("--prompt_num", "200"), ("--prompt_bs", "8")):
    if flag in src:
        sys.argv += [flag, value]
# mesh_sam() sets point_num = 100000 and prompt_num = 400 itself, whatever the flags say: a copy with those two lines
# lowered runs instead (beside it, so its imports work), and is removed after.
import re
light, n1 = re.subn(r"\\bpoint_num\\s*=\\s*100000\\b", "point_num = 30000", src)
light, n2 = re.subn(r"\\bprompt_num\\s*=\\s*400\\b", "prompt_num = 200", light)
# Said in the log, so a run on the PC shows whether the lighter settings took.
print(f"kesher: lighter run (points lowered in {n1} place(s), prompts in {n2})", flush=True)
script = os.path.join(demo, "auto_mask_kesher.py")
open(script, "w", encoding="utf-8").write(light)
os.chdir(demo)
try:
    runpy.run_path(script, run_name="__main__")
finally:
    try:
        os.remove(script)
    except OSError:
        pass
ids = sorted(glob.glob(os.path.join(out, "**", "*face_ids.npy"), recursive=True))
if not ids:
    raise SystemExit("P3-SAM wrote no face ids")
labels = np.load(ids[-1])
mesh = trimesh.load(a["mesh"], force="mesh")
c = mesh.triangles_center
n = min(len(c), len(labels))
json.dump({"faces": [[round(float(x), 5) for x in c[i]] + [int(labels[i])] for i in range(n)]}, open(os.path.join(out, "parts.json"), "w"))
print("DONE", n)
`;

/**
 * The code (the Hunyuan3D-Part Space) and the weights (its model page), each at one fixed revision: the one recorded by
 * the first setup (trust on first use, security review scan 149), so setting up again never takes newer, unseen code.
 */
const FETCH = `import glob, json, os, sys
from huggingface_hub import HfApi, snapshot_download
d = sys.argv[1]
old = {}
if os.path.exists(os.path.join(d, "paths.json")):
    old = json.load(open(os.path.join(d, "paths.json")))
api = HfApi()
code_rev = old.get("codeRevision") or api.space_info("tencent/Hunyuan3D-Part").sha
w_rev = old.get("weightsRevision") or api.model_info("tencent/Hunyuan3D-Part").sha
code = snapshot_download(repo_id="tencent/Hunyuan3D-Part", repo_type="space", revision=code_rev, local_dir=os.path.join(d, "code"))
w = snapshot_download(repo_id="tencent/Hunyuan3D-Part", revision=w_rev, local_dir=os.path.join(d, "weights"), allow_patterns=["*p3sam*", "*P3-SAM*", "*p3-sam*"])
ck = [f for f in glob.glob(os.path.join(w, "**", "*"), recursive=True) if f.endswith((".ckpt", ".safetensors", ".pt", ".pth"))]
json.dump({"code": code, "ckpt": ck[0] if ck else None, "codeRevision": code_rev, "weightsRevision": w_rev}, open(os.path.join(d, "paths.json"), "w"))
print("FETCHED", len(ck), "code", code_rev, "weights", w_rev)
`;

/** Installs P3-SAM once and splits meshes into parts with it. */
export class PartSegmenter {
  private state: PartSegState = { installed: false, log: [] };
  private busy?: Promise<unknown>;
  /** The program running now (to stop it). */
  private child?: ChildProcess;

  /**
   * @param dir - engines/p3sam.
   * @param uv - The path to uv (installs it if needed).
   * @param freeGpuBytes - The most free memory on any graphics card now (the GPU guard's reading), when known.
   */
  constructor(
    private readonly dir: string,
    private readonly uv: () => Promise<string>,
    private readonly freeGpuBytes?: () => number | undefined | Promise<number | undefined>,
  ) {}

  private get python() {
    return join(this.dir, "venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
  }

  /** @returns Whether it is set up, what it is doing, and the last lines of its log. */
  status(): PartSegState {
    return { ...this.state, installed: existsSync(join(this.dir, "paths.json")) && existsSync(this.python), log: this.state.log.slice(-40) };
  }

  private add(line: string) {
    this.state.log.push(line.slice(0, 300));
    if (this.state.log.length > 300) this.state.log.splice(0, 100);
  }

  /** Set by {@link cancel}, so the run's end is not shown as an error. */
  private stopped = false;

  private run(cmd: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs = 60 * 60_000): Promise<string> {
    return new Promise((ok, fail) => {
      const p = spawn(cmd, args, { env, windowsHide: true });
      this.child = p;
      let out = "";
      const on = (b: Buffer) => {
        out += b.toString();
        b.toString().split(/\r?\n/).filter(Boolean).forEach((l) => this.add(l));
      };
      const timer = setTimeout(() => p.kill(), timeoutMs);
      p.stdout.on("data", on);
      p.stderr.on("data", on);
      p.on("error", (e) => (clearTimeout(timer), fail(e)));
      p.on("close", (code) => (clearTimeout(timer), (this.child = undefined), code === 0 ? ok(out) : fail(new Error(`${cmd.split(/[\\/]/).pop()} stopped (code ${code}); see the log.`))));
    });
  }

  /**
   * Stops a split that is running (the setup is left to finish, so its venv is never half-written).
   *
   * @returns Whether something was stopped.
   */
  cancel(): boolean {
    if (this.state.phase !== "working" || !this.child) return false;
    this.stopped = true;
    this.child.kill();
    this.add("Stopped by the user.");
    // The screen leaves "Splitting…" at once (the run's own end may take a moment to arrive).
    Object.assign(this.state, { phase: undefined, message: "Stopped." });
    return true;
  }

  /**
   * The Space's requirements without what cannot install here: PyTorch (installed first, with CUDA), wheels by address
   * (built for the Space's Linux), flash-attn (optional for Sonata) and Gradio's app parts.
   *
   * @param text - requirements.txt.
   * @returns The lines to install.
   */
  static requirements(text: string): string[] {
    return text
      .split(/\r?\n/)
      .map((l) => l.replace(/#.*$/, "").trim())
      .filter((l) => l && !/^(-|torch\b(?![-_])|torchvision\b|torchaudio\b|torch[-_](scatter|cluster)\b|flash[-_]attn|gradio|spaces\b|xformers|spconv)/i.test(l) && !/^(git\+)?https?:|\.whl\b|@\s*(git\+)?https?:|flash-attention/i.test(l));
  }

  /** Installs Python 3.10, PyTorch with CUDA, P3-SAM's code, its requirements and its weights (a few GB, once). */
  install(): Promise<unknown> {
    this.busy ??= (async () => {
      Object.assign(this.state, { phase: "installing", message: "Setting up Python, PyTorch and P3-SAM (a few GB, once)…" });
      try {
        const uv = await this.uv();
        const env = { ...process.env, UV_PYTHON_INSTALL_DIR: join(this.dir, "python"), UV_CACHE_DIR: join(this.dir, "uv-cache"), HF_HOME: join(this.dir, "hf") };
        await mkdir(this.dir, { recursive: true });
        if (!existsSync(this.python)) await this.run(uv, ["venv", "--python", "3.10", "--seed", join(this.dir, "venv")], env);
        await this.run(uv, ["pip", "install", "--python", this.python, "torch==2.5.1", "torchvision==0.20.1", "--index-url", "https://download.pytorch.org/whl/cu124"], env);
        await this.run(uv, ["pip", "install", "--python", this.python, "huggingface_hub", "trimesh", "scikit-learn", "fpsample", "numba", "tqdm", "addict", "timm"], env);
        // spconv (Sonata's sparse convolutions): the build for CUDA 12.4, else the one for 12.0 (it runs on newer drivers).
        await this.run(uv, ["pip", "install", "--python", this.python, "spconv-cu124"], env).catch(() => this.run(uv, ["pip", "install", "--python", this.python, "spconv-cu120"], env)).catch((e) => this.add(`spconv: ${(e as Error).message}`));
        // torch-scatter and torch-cluster built for this torch and CUDA, from PyG's wheels (Windows too), never from source.
        await this.run(uv, ["pip", "install", "--python", this.python, "--only-binary", ":all:", "torch-scatter", "torch-cluster", "-f", "https://data.pyg.org/whl/torch-2.5.1+cu124.html"], env).catch((e) => this.add(`torch-scatter / torch-cluster: ${(e as Error).message}`));
        await writeFile(join(this.dir, "fetch.py"), FETCH);
        await this.run(this.python, [join(this.dir, "fetch.py"), this.dir], env);
        const paths = JSON.parse(await readFile(join(this.dir, "paths.json"), "utf8")) as { code: string };
        const req = await readFile(join(paths.code, "requirements.txt"), "utf8").catch(() => "");
        const lines = PartSegmenter.requirements(req);
        // All at once; if one will not install here, the others one by one, so a single package does not stop the rest.
        if (lines.length)
          await this.run(uv, ["pip", "install", "--python", this.python, ...lines], env).catch(async () => {
            for (const l of lines) await this.run(uv, ["pip", "install", "--python", this.python, l], env).catch(() => this.add(`skipped: ${l}`));
          });
        await writeFile(join(this.dir, "runner.py"), RUNNER);
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
   * Splits a mesh (a GLB of one mesh) into parts.
   *
   * @param glb - The mesh.
   * @returns For each triangle: its centre (x, y, z) and its part number (−1, −2: no part).
   */
  async segment(glb: Buffer): Promise<Array<[number, number, number, number]>> {
    if (!this.status().installed) throw Object.assign(new Error("Set up the parts engine first."), { statusCode: 409 });
    if (this.busy) throw Object.assign(new Error("The parts engine is busy; try again in a moment."), { statusCode: 409 });
    // With a model already filling the card (self-work's, a chat's), this would crawl in shared memory for minutes: say so.
    const free = await this.freeGpuBytes?.();
    if (free !== undefined && free < 6 * 1024 ** 3) throw Object.assign(new Error(`The graphics card is full (${(free / 1024 ** 3).toFixed(1)} GB free; the parts engine needs about 6 GB). Unload the model in Models, or wait for self-work to finish.`), { statusCode: 409, code: "gpu-full" });
    if (glb.length < 20 || glb.subarray(0, 4).toString() !== "glTF") throw Object.assign(new Error("Send the mesh as a GLB."), { statusCode: 400 });
    const work = join(this.dir, "work", randomUUID());
    const job = (async () => {
      Object.assign(this.state, { phase: "working", message: "Splitting into parts…" });
      await mkdir(work, { recursive: true });
      try {
        await writeFile(join(work, "in.glb"), glb);
        // The runner is written again before every split: written only at setup, the lighter settings of later versions
        // never reached a computer set up before them (found on the PC: 24 GB filled, no "kesher: lighter run" line).
        await writeFile(join(this.dir, "runner.py"), RUNNER);
        const paths = JSON.parse(await readFile(join(this.dir, "paths.json"), "utf8")) as { code: string; ckpt?: string };
        const env = { ...process.env, HF_HOME: join(this.dir, "hf"), PYTHONIOENCODING: "utf-8", PYTHONUNBUFFERED: "1" };
        await this.run(this.python, [join(this.dir, "runner.py"), JSON.stringify({ code: paths.code, ckpt: paths.ckpt ?? null, mesh: join(work, "in.glb"), out: join(work, "out"), sonata: join(this.dir, "sonata") })], env, 20 * 60_000);
        const r = JSON.parse(await readFile(join(work, "out", "parts.json"), "utf8")) as { faces: Array<[number, number, number, number]> };
        Object.assign(this.state, { phase: undefined, message: `Split into ${new Set(r.faces.map((f) => f[3]).filter((l) => l >= 0)).size} parts.` });
        return r.faces;
      } catch (e) {
        // Stopped by her: not an error on the screen.
        if (this.stopped) Object.assign(this.state, { phase: undefined, message: "Stopped." });
        else Object.assign(this.state, { phase: "error", message: (e as Error).message });
        throw e;
      } finally {
        this.stopped = false;
        await rm(work, { recursive: true, force: true }).catch(() => undefined);
      }
    })();
    this.busy = job.finally(() => (this.busy = undefined));
    return job;
  }
}

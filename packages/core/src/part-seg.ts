import { spawn } from "node:child_process";
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

/** Our own runner around P3-SAM's demo: runs it on one mesh, then writes each face's centre and part as JSON. */
const RUNNER = `import glob, json, os, subprocess, sys
import numpy as np, trimesh
a = json.loads(sys.argv[1])
demo = os.path.join(a["code"], "P3-SAM", "demo")
out = a["out"]
os.makedirs(out, exist_ok=True)
args = [sys.executable, "auto_mask.py", "--mesh_path", a["mesh"], "--output_path", out, "--parallel", "0", "--post_process", "0", "--clean_mesh", "0", "--save_mid_res", "0", "--show_info", "0", "--show_time_info", "0"]
if a.get("ckpt"):
    args += ["--ckpt_path", a["ckpt"]]
subprocess.run(args, cwd=demo, check=True)
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

/** The weights: the newest checkpoint of P3-SAM in the Hunyuan3D-Part model page (or none, and the code finds its own). */
const FETCH = `import glob, json, os, sys
from huggingface_hub import snapshot_download
d = sys.argv[1]
code = snapshot_download(repo_id="tencent/Hunyuan3D-Part", repo_type="space", local_dir=os.path.join(d, "code"))
w = snapshot_download(repo_id="tencent/Hunyuan3D-Part", local_dir=os.path.join(d, "weights"), allow_patterns=["*p3sam*", "*P3-SAM*", "*p3-sam*"])
ck = [f for f in glob.glob(os.path.join(w, "**", "*"), recursive=True) if f.endswith((".ckpt", ".safetensors", ".pt", ".pth"))]
json.dump({"code": code, "ckpt": ck[0] if ck else None}, open(os.path.join(d, "paths.json"), "w"))
print("FETCHED", len(ck))
`;

/** Installs P3-SAM once and splits meshes into parts with it. */
export class PartSegmenter {
  private state: PartSegState = { installed: false, log: [] };
  private busy?: Promise<unknown>;

  /**
   * @param dir - engines/p3sam.
   * @param uv - The path to uv (installs it if needed).
   */
  constructor(
    private readonly dir: string,
    private readonly uv: () => Promise<string>,
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

  private run(cmd: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs = 60 * 60_000): Promise<string> {
    return new Promise((ok, fail) => {
      const p = spawn(cmd, args, { env, windowsHide: true });
      let out = "";
      const on = (b: Buffer) => {
        out += b.toString();
        b.toString().split(/\r?\n/).filter(Boolean).forEach((l) => this.add(l));
      };
      const timer = setTimeout(() => p.kill(), timeoutMs);
      p.stdout.on("data", on);
      p.stderr.on("data", on);
      p.on("error", (e) => (clearTimeout(timer), fail(e)));
      p.on("close", (code) => (clearTimeout(timer), code === 0 ? ok(out) : fail(new Error(`${cmd.split(/[\\/]/).pop()} stopped (code ${code}); see the log.`))));
    });
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
      .filter((l) => l && !/^(-|torch\b|torchvision\b|torchaudio\b|flash[-_]attn|gradio|spaces\b|xformers|spconv)/i.test(l) && !/^https?:|\.whl\b|@\s*https?:/i.test(l));
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
        await this.run(uv, ["pip", "install", "--python", this.python, "huggingface_hub", "trimesh", "numpy<2", "scikit-learn", "fpsample", "numba", "tqdm", "addict", "timm", "spconv-cu124"], env);
        // torch-scatter for this torch and CUDA, from PyG's wheels (Sonata's point backbone uses it).
        await this.run(uv, ["pip", "install", "--python", this.python, "torch-scatter", "-f", "https://data.pyg.org/whl/torch-2.5.1+cu124.html"], env).catch((e) => this.add(`torch-scatter: ${(e as Error).message}`));
        await writeFile(join(this.dir, "fetch.py"), FETCH);
        await this.run(this.python, [join(this.dir, "fetch.py"), this.dir], env);
        const paths = JSON.parse(await readFile(join(this.dir, "paths.json"), "utf8")) as { code: string };
        const req = await readFile(join(paths.code, "requirements.txt"), "utf8").catch(() => "");
        const lines = PartSegmenter.requirements(req);
        if (lines.length) await this.run(uv, ["pip", "install", "--python", this.python, ...lines], env).catch((e) => this.add(`requirements: ${(e as Error).message}`));
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
    if (glb.length < 20 || glb.subarray(0, 4).toString() !== "glTF") throw Object.assign(new Error("Send the mesh as a GLB."), { statusCode: 400 });
    const work = join(this.dir, "work", randomUUID());
    const job = (async () => {
      Object.assign(this.state, { phase: "working", message: "Splitting into parts…" });
      await mkdir(work, { recursive: true });
      try {
        await writeFile(join(work, "in.glb"), glb);
        const paths = JSON.parse(await readFile(join(this.dir, "paths.json"), "utf8")) as { code: string; ckpt?: string };
        const env = { ...process.env, HF_HOME: join(this.dir, "hf"), PYTHONIOENCODING: "utf-8" };
        await this.run(this.python, [join(this.dir, "runner.py"), JSON.stringify({ code: paths.code, ckpt: paths.ckpt ?? null, mesh: join(work, "in.glb"), out: join(work, "out") })], env, 20 * 60_000);
        const r = JSON.parse(await readFile(join(work, "out", "parts.json"), "utf8")) as { faces: Array<[number, number, number, number]> };
        Object.assign(this.state, { phase: undefined, message: `Split into ${new Set(r.faces.map((f) => f[3]).filter((l) => l >= 0)).size} parts.` });
        return r.faces;
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

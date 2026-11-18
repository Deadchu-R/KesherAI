/**
 * Lip sync for the avatar camera (Windows, NVIDIA card of 8 GB or more, optional): MuseTalk moves the lips of the
 * student's recorded clip to her voice while she talks (tools/lipsync/kesher_lipsync.py). Installed on request into
 * KesherAI's engines folder (its own Python 3.10 through uv, PyTorch for CUDA 11.8, MuseTalk and its models; about 7
 * GB), with the Windows fixes found when testing it (chumpy without build isolation, setuptools below 70, the s3fd
 * face detector from HuggingFace checked by its hash, UTF-8 output). Runs only while the avatar camera does.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** What the avatar page and the wizard show. */
export interface LipSyncStatus {
  /** This computer can run it (Windows, NVIDIA with 8 GB or more). */
  possible: boolean;
  installed: boolean;
  /** Installing: the step now ("PyTorch", "models"…). */
  installing?: string;
  running: boolean;
  /** She turned it on: it starts with the avatar camera. */
  enabled: boolean;
  /** Its voice goes, held back, into this audio device (a virtual cable such as VB-Cable). */
  cable?: string;
  /** The microphone it listens to (Windows' default when absent). */
  mic?: string;
  error?: string;
  /** The last self-test's proof (t131): whether the made mouths really moved, and by how much (pixel levels). */
  check?: LipCheck;
}

/** The self-test's measure: the mouth against the clip's own, and from frame to frame. */
export interface LipCheck { moving: boolean; vsClip: number; between: number; frames: number; at: number }

/**
 * Reads the script's {"lipcheck": …} line.
 *
 * @param line - One line of its output.
 * @returns The check, or undefined when the line is not one.
 */
export function parseLipCheck(line: string, at = Date.now()): LipCheck | undefined {
  const i = line.indexOf('{"lipcheck"');
  if (i < 0) return undefined;
  try {
    const c = (JSON.parse(line.slice(i)) as { lipcheck?: Record<string, unknown> }).lipcheck;
    if (!c) return undefined;
    const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
    return { moving: c.moving === true, vsClip: n(c.vsClip), between: n(c.between), frames: n(c.frames), at };
  } catch {
    return undefined;
  }
}

const MUSETALK = "https://github.com/TMElyralab/MuseTalk";

/** The install steps, run by PowerShell from the engines folder; each "== name" line is shown as progress. */
export function installScript(dir: string): string {
  const q = (p: string) => p.replace(/'/g, "''");
  const mt = join(dir, "MuseTalk");
  const py = join(mt, ".venv", "Scripts", "python.exe");
  return [
    "$ErrorActionPreference = 'Stop'",
    `$env:UV_CACHE_DIR = '${q(join(dir, "uv-cache"))}'`,
    `$env:UV_PYTHON_INSTALL_DIR = '${q(join(dir, "python"))}'`,
    `$env:HF_HOME = '${q(join(dir, "hf"))}'`,
    "$env:PYTHONIOENCODING = 'utf-8'",
    "'== tools'",
    "python -m pip install --user --quiet uv",
    `if (!(Test-Path '${q(mt)}')) { git clone --quiet --depth 1 ${MUSETALK} '${q(mt)}' }`,
    `Set-Location '${q(mt)}'`,
    "'== python'",
    "python -m uv venv -p 3.10 .venv",
    "'== pytorch'",
    "python -m uv pip install -p .venv torch==2.0.1 torchvision==0.15.2 torchaudio==2.0.2 --index-url https://download.pytorch.org/whl/cu118",
    "'== packages'",
    "python -m uv pip install -p .venv diffusers==0.30.2 accelerate==0.28.0 numpy==1.23.5 opencv-python==4.9.0.80 soundfile==0.12.1 transformers==4.39.2 huggingface_hub==0.30.2 librosa==0.11.0 einops==0.8.1 omegaconf sounddevice websockets 'setuptools<70' pip",
    `& '${q(py)}' -m pip install --quiet mmengine`,
    `& '${q(py)}' -m pip install --quiet mmcv==2.0.1 -f https://download.openmmlab.com/mmcv/dist/cu118/torch2.0/index.html`,
    `& '${q(py)}' -m pip install --quiet --no-build-isolation chumpy`,
    `& '${q(py)}' -m pip install --quiet mmdet==3.1.0 mmpose==1.1.0`,
    "'== models'",
    `& '${q(py)}' -c "from huggingface_hub import snapshot_download as d, hf_hub_download as h; import hashlib, os, shutil; c='models'; d('TMElyralab/MuseTalk', local_dir=c); d('stabilityai/sd-vae-ft-mse', local_dir=c+'/sd-vae', allow_patterns=['config.json','diffusion_pytorch_model.bin']); d('openai/whisper-tiny', local_dir=c+'/whisper', allow_patterns=['config.json','pytorch_model.bin','preprocessor_config.json']); d('yzd-v/DWPose', local_dir=c+'/dwpose', allow_patterns=['dw-ll_ucoco_384.pth']); d('ManyOtherFunctions/face-parse-bisent', local_dir=c+'/face-parse-bisent', allow_patterns=['79999_iter.pth','resnet18-5c106cde.pth']); p=h('chunyu-li/face-alignment','s3fd-619a316812.pth'); assert hashlib.sha256(open(p,'rb').read()).hexdigest().startswith('619a316812'); t=os.path.join(os.path.expanduser('~'),'.cache','torch','hub','checkpoints'); os.makedirs(t, exist_ok=True); shutil.copy(p, t)"`,
    "'== check'",
    `& '${q(py)}' -c "import torch, mmpose, sounddevice, websockets; assert torch.cuda.is_available(); print('cuda ok')"`,
    "if ($LASTEXITCODE) { exit 1 }",
    `Set-Content '${q(join(dir, "ready"))}' 'ok'`,
    "'== done'",
  ].join("\r\n");
}

/** The lip sync engine. */
export class LipSync {
  private proc?: ChildProcess;
  private port = 0;
  private token = randomBytes(16).toString("hex");
  private installing?: string;
  private error?: string;
  private check?: LipCheck;

  /**
   * @param dir - Its folder (in KesherAI's engines folder).
   * @param script - kesher_lipsync.py (shipped with the app).
   * @param clip - The student's recorded avatar clip.
   * @param gpu - The NVIDIA card's memory (GB), if any.
   */
  constructor(
    private readonly dir: string,
    private readonly script: () => string | undefined,
    private readonly clip: string,
    private readonly gpu: () => Promise<number>,
  ) {}

  private get python() {
    return join(this.dir, "MuseTalk", ".venv", "Scripts", "python.exe");
  }

  /** @returns Where it stands. */
  async status(): Promise<LipSyncStatus> {
    const possible = process.platform === "win32" && (await this.gpu().catch(() => 0)) >= 8 && !!this.script();
    const set = await this.settings();
    return {
      possible,
      installed: existsSync(join(this.dir, "ready")) && existsSync(this.python),
      ...(this.installing ? { installing: this.installing } : {}),
      running: !!this.proc,
      enabled: !!set.enabled,
      ...(set.cable ? { cable: set.cable } : {}),
      ...(set.mic ? { mic: set.mic } : {}),
      ...(this.error ? { error: this.error } : {}),
      ...(this.check ? { check: this.check } : {}),
    };
  }

  /** Installs it (about 7 GB; resolves when done). */
  async install(): Promise<void> {
    if (this.installing) return;
    if (!(await this.status()).possible) throw Object.assign(new Error("Lip sync needs Windows and an NVIDIA card with 8 GB or more."), { statusCode: 409 });
    await mkdir(this.dir, { recursive: true });
    const ps1 = join(this.dir, "install.ps1");
    await writeFile(ps1, installScript(this.dir), "utf8");
    this.installing = "starting";
    this.error = undefined;
    await new Promise<void>((done) => {
      const p = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps1], { cwd: this.dir, windowsHide: true });
      let tail = "";
      const read = (b: Buffer) => {
        const t = b.toString();
        tail = (tail + t).slice(-2000);
        for (const m of t.matchAll(/^== (\w+)/gm)) this.installing = m[1];
      };
      p.stdout.on("data", read);
      p.stderr.on("data", (b: Buffer) => (tail = (tail + b.toString()).slice(-2000)));
      p.on("exit", (code) => {
        if (code !== 0) this.error = `The lip sync install stopped: ${tail.trim().split("\n").slice(-3).join(" ").slice(0, 400)}`;
        this.installing = undefined;
        done();
      });
      p.on("error", (e) => {
        this.error = e.message;
        this.installing = undefined;
        done();
      });
    });
  }

  /**
   * Starts it (the avatar camera is on); resolves when it listens.
   *
   * @param test - The self-test: MuseTalk's sample recording plays instead of the microphone.
   */
  async start(test = false): Promise<void> {
    if (this.proc) return;
    const st = await this.status();
    const script = this.script();
    if (!st.installed || !script) throw Object.assign(new Error("Lip sync is not installed."), { statusCode: 409 });
    if (!existsSync(this.clip)) throw Object.assign(new Error("Record the avatar clip first."), { statusCode: 409 });
    const mt = join(this.dir, "MuseTalk");
    await copyFile(script, join(mt, "kesher_lipsync.py"));
    this.port = 28700 + Math.floor(Math.random() * 200);
    const args = ["kesher_lipsync.py", "--clip", this.clip, "--work", join(this.dir, "avatars"), "--port", String(this.port), "--token", this.token];
    if (st.cable) args.push("--cable", st.cable);
    if (st.mic) args.push("--mic", st.mic);
    if (test) {
      args.push("--test-audio", join(mt, "data", "audio", "eng.wav"));
      this.check = undefined;
    }
    const p = spawn(this.python, args, { cwd: mt, windowsHide: true, env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" } });
    this.proc = p;
    this.error = undefined;
    let tail = "";
    p.stderr?.on("data", (b: Buffer) => (tail = (tail + b.toString()).slice(-1500)));
    p.on("exit", () => {
      if (this.proc === p) this.proc = undefined;
    });
    // Ready once it prints {"ready": true} (preparing a new clip takes a minute or two).
    await new Promise<void>((done, fail) => {
      const timer = setTimeout(() => fail(new Error("Lip sync did not start in time.")), 5 * 60_000);
      p.stdout?.on("data", (b: Buffer) => {
        for (const line of b.toString().split("\n")) {
          const c = parseLipCheck(line);
          if (c) this.check = c;
        }
        if (/"ready": true/.test(b.toString())) {
          clearTimeout(timer);
          done();
        }
      });
      p.on("exit", () => {
        clearTimeout(timer);
        this.error = `Lip sync stopped: ${tail.trim().split("\n").slice(-2).join(" ").slice(0, 300)}`;
        fail(new Error(this.error));
      });
    });
  }

  /** Stops it (gives the graphics card back). */
  stop(): void {
    this.proc?.kill();
    this.proc = undefined;
  }

  /** The frames' address on this computer (for KesherAI's own relay), while it runs. */
  upstream(): string | undefined {
    return this.proc ? `ws://127.0.0.1:${this.port}/?token=${this.token}` : undefined;
  }

  private async settings(): Promise<{ enabled?: boolean; cable?: string; mic?: string }> {
    return readFile(join(this.dir, "settings.json"), "utf8").then((t) => JSON.parse(t) as { enabled?: boolean; cable?: string; mic?: string }, () => ({}));
  }

  /** The computer's microphones (from the installed engine), Windows' default marked. */
  async mics(): Promise<Array<{ name: string; default: boolean }>> {
    const script = this.script();
    if (!script || !existsSync(this.python)) return [];
    const mt = join(this.dir, "MuseTalk");
    await copyFile(script, join(mt, "kesher_lipsync.py"));
    return new Promise((done) => {
      const p = spawn(this.python, ["kesher_lipsync.py", "--clip", "-", "--work", "-", "--list-mics"], { cwd: mt, windowsHide: true, env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" } });
      let out = "";
      p.stdout.on("data", (b: Buffer) => (out += b.toString()));
      p.on("exit", () => {
        try {
          done((JSON.parse(out.trim().split("\n").pop() ?? "[]") as Array<{ name: string; default: boolean }>).slice(0, 40));
        } catch {
          done([]);
        }
      });
      p.on("error", () => done([]));
    });
  }

  /**
   * Her choices: on or off (with the avatar camera), and the audio device for the held-back voice ("" for none);
   * they take effect at the next start.
   */
  async set(p: { enabled?: boolean; cable?: string; mic?: string }): Promise<void> {
    const cur = await this.settings();
    if (typeof p.mic === "string") {
      if (p.mic) cur.mic = p.mic.slice(0, 120);
      else delete cur.mic;
    }
    if (typeof p.enabled === "boolean") cur.enabled = p.enabled;
    if (typeof p.cable === "string") {
      if (p.cable) cur.cable = p.cable.slice(0, 120);
      else delete cur.cable;
    }
    await mkdir(this.dir, { recursive: true });
    await writeFile(join(this.dir, "settings.json"), JSON.stringify(cur));
  }
}

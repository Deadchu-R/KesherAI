import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { createInterface } from "node:readline";

/**
 * A natural Hebrew voice on this computer (Roee, 2026-11-23: every model he installed must work in KesherAI). Kokoro
 * speaks English only, so Hebrew went to the system's voice. Now 🔊 and voice mode can read Hebrew with F5-TTS and the
 * Hebrew fine-tune `Yzamari/f5tts-hebrew-v2` (F5-TTS v1 Base, about 1.3 GB, the file he already has), in its own Python
 * (the pattern of voice-clone.ts and bg-remove.ts): Python 3.11, PyTorch, `f5-tts` and Phonikud (adds the nikud the
 * model was trained with). The model stays loaded in one Python process between sentences, and the process ends after
 * a few idle minutes so the graphics card is free for the chat model.
 *
 * Zonos-Hebrew is found and shown, but not run: its hybrid model needs mamba-ssm and eSpeak, which do not install on
 * Windows without manual steps (RESEARCH_LOG "Hebrew text to speech from the installed models").
 */

/** The Hebrew voice engines the Settings choice offers. `system`: the computer's (or the phone's) own voice. */
export const HEBREW_TTS_ENGINES = ["system", "f5", "zonos"] as const;
/** One of {@link HEBREW_TTS_ENGINES}. */
export type HebrewTtsEngine = (typeof HEBREW_TTS_ENGINES)[number];

/** The Hugging Face repo of the Hebrew F5-TTS fine-tune (downloaded only when it is not on the computer). */
export const F5_HEBREW_REPO = "Yzamari/f5tts-hebrew-v2";
/** About how much the engine downloads once (Python, PyTorch with CUDA, f5-tts, Phonikud), in GB. */
export const F5_ENGINE_GB = 3.6;
/** The fine-tune's size, in GB (downloaded only when it is not on the computer). */
export const F5_MODEL_GB = 1.3;
/** How long the loaded model stays in the graphics card without a sentence to read (ms). */
const IDLE_MS = 5 * 60_000;

/** A model file found on the computer (model-scan.ts FoundModel, the fields used here). */
export interface SpeechFile {
  path: string;
  name: string;
}

/** Speech models on the computer, sorted by what KesherAI does with them. */
export interface SpeechModels {
  /** The Hebrew F5-TTS checkpoint KesherAI can run. */
  f5?: SpeechFile;
  /** Zonos checkpoints (found, not run on Windows). */
  zonos: SpeechFile[];
  /** Speech-to-text models that are not whisper (wav2vec2, others): not used; whisper with ivrit-ai is. */
  otherStt: SpeechFile[];
}

/**
 * Sorts the speech models found on the computer (pure; the route passes the scan's results).
 *
 * @param found - Model files from the scan (the user's model folders and KesherAI's speech folders).
 * @returns The Hebrew F5 checkpoint (the biggest match), the Zonos files and the speech-to-text models KesherAI does not use.
 */
export function classifySpeechModels(found: readonly SpeechFile[]): SpeechModels {
  const text = (f: SpeechFile) => `${f.path} ${f.name}`.replace(/\\/g, "/");
  const f5 = found.filter((f) => /f5[-_]?tts/i.test(text(f)) && /hebrew|[-_/]he([-_/.]|$)/i.test(text(f)) && /\.(safetensors|pt)$/i.test(f.path));
  return {
    ...(f5[0] ? { f5: f5[0] } : {}),
    zonos: found.filter((f) => /zonos/i.test(text(f))),
    otherStt: found.filter((f) => /wav2vec2|earlybird|hubert|xlsr/i.test(text(f)) && !/whisper/i.test(text(f))),
  };
}

/**
 * The vocabulary file beside an F5 checkpoint: `vocab.txt`, the checkpoint's own name with `.txt` (the ComfyUI
 * F5-TTS node's layout), or the only `.txt` in its folder.
 *
 * @param checkpoint - The model file.
 * @param list - Lists a folder (tests pass a fake).
 * @returns The file's path, or undefined when there is none.
 */
export async function vocabBeside(checkpoint: string, list: (dir: string) => Promise<string[]> = (d) => readdir(d).catch(() => [])): Promise<string | undefined> {
  const dir = dirname(checkpoint);
  const txt = (await list(dir)).filter((n) => /\.txt$/i.test(n) && !/readme|license/i.test(n));
  const own = `${basename(checkpoint).replace(/\.[^.]+$/, "")}.txt`;
  const pick = txt.find((n) => n.toLowerCase() === "vocab.txt") ?? txt.find((n) => n === own) ?? (txt.length === 1 ? txt[0] : undefined);
  return pick ? join(dir, pick) : undefined;
}

/**
 * The Python side: one process, reading one JSON request per line on stdin and answering one `KESHER {json}` line on
 * stdout. The model loads at the first request. The text gets its nikud from Phonikud; characters the model's
 * vocabulary does not have are left out (Phonikud also marks stress, which the model was not trained with).
 */
const WORKER = `import json, os, sys, traceback
from importlib.resources import files
def answer(o):
    print("KESHER " + json.dumps(o, ensure_ascii=False), flush=True)
cfg = json.loads(sys.argv[1])
tts = nikud = None
vocab = set()
def load():
    global tts, nikud, vocab
    import torch
    from huggingface_hub import hf_hub_download
    from phonikud_onnx import Phonikud
    from f5_tts.api import F5TTS
    model, voc = cfg.get("model"), cfg.get("vocab")
    if not model:
        model = hf_hub_download(cfg["repo"], "model.safetensors")
    if not voc:
        voc = hf_hub_download(cfg["repo"], "vocab.txt")
    nk = None
    for repo, name in (("thewh1teagle/phonikud-onnx", "phonikud-1.0.int8.onnx"), ("Phonikud/phonikud-onnx", "phonikud-1.0.int8.onnx"), ("thewh1teagle/phonikud", "phonikud-onnx-1.0.int8.onnx")):
        try:
            nk = hf_hub_download(repo, name)
            break
        except Exception as e:
            print("phonikud:", repo, name, e, flush=True)
    if not nk:
        raise RuntimeError("The nikud model (Phonikud) could not be downloaded.")
    nikud = Phonikud(nk)
    vocab = set(open(voc, encoding="utf-8").read().splitlines())
    device = "cuda" if torch.cuda.is_available() else "cpu"
    try:
        tts = F5TTS(model="F5TTS_v1_Base", ckpt_file=model, vocab_file=voc, device=device)
    except torch.cuda.OutOfMemoryError:
        tts = F5TTS(model="F5TTS_v1_Base", ckpt_file=model, vocab_file=voc, device="cpu")
    print("LOADED", device, flush=True)
if cfg.get("prepare"):
    load()
    answer({"ok": True, "prepared": True})
    sys.exit(0)
for line in sys.stdin:
    try:
        r = json.loads(line)
    except Exception:
        continue
    try:
        if tts is None:
            load()
        text = nikud.add_diacritics(r["text"])
        text = "".join(c for c in text if c in vocab or c.isspace() or c in ".,!?;:-'\\"")
        ref = r.get("ref") or str(files("f5_tts").joinpath("infer/examples/basic/basic_ref_en.wav"))
        ref_text = r.get("refText") if r.get("ref") else "Some call me nature, others call me mother nature."
        tts.infer(ref_file=ref, ref_text=ref_text or "", gen_text=text, speed=float(r.get("speed") or 1), file_wave=r["out"], remove_silence=False, show_info=lambda *a: None)
        answer({"id": r["id"], "ok": True})
    except Exception as e:
        traceback.print_exc()
        answer({"id": r.get("id"), "ok": False, "error": str(e)[:300]})
`;

/**
 * Reads one answer line of the Python worker.
 *
 * @param line - A line of its stdout.
 * @returns The answer, or undefined for a log line.
 */
export function parseWorkerLine(line: string): { id?: string; ok: boolean; error?: string; prepared?: boolean } | undefined {
  if (!line.startsWith("KESHER ")) return undefined;
  try {
    const o = JSON.parse(line.slice(7)) as { id?: string; ok?: boolean; error?: string; prepared?: boolean };
    return { ...o, ok: o.ok === true };
  } catch {
    return undefined;
  }
}

/** What the Hebrew voice engine is doing, for Settings and "Models per job". */
export interface HebrewTtsState {
  /** Python, PyTorch, f5-tts and Phonikud are installed. */
  installed: boolean;
  phase?: "installing" | "loading" | "speaking" | "error";
  message?: string;
  /** The checkpoint on the computer it uses (a short name), or undefined: it downloads the fine-tune at setup. */
  model?: string;
  /** The model is loaded in a running process now. */
  loaded: boolean;
  /** What setting it up downloads, in GB. */
  sizeGb: number;
  log: string[];
}

/** Starts the Python worker (tests pass a fake). */
export type SpawnWorker = (python: string, args: string[], env: NodeJS.ProcessEnv) => ChildProcess;

/** Sets F5-TTS with the Hebrew fine-tune up once, and reads Hebrew text aloud with it. */
export class F5Hebrew {
  private state: { phase?: HebrewTtsState["phase"]; message?: string; log: string[] } = { log: [] };
  private installing?: Promise<void>;
  private child?: ChildProcess;
  private loaded = false;
  private idle?: ReturnType<typeof setTimeout>;
  private waiting = new Map<string, { ok: () => void; fail: (e: Error) => void }>();
  private queue: Promise<unknown> = Promise.resolve();

  /**
   * @param dir - engines/f5-hebrew.
   * @param opts - uv (installs it when needed), whether there is an NVIDIA card, the checkpoint on the computer (and
   *   its vocabulary) when there is one, and the worker's starter (tests).
   */
  constructor(
    private readonly dir: string,
    private readonly opts: {
      uv: () => Promise<string>;
      nvidia: () => Promise<boolean>;
      checkpoint: () => Promise<{ model?: string; vocab?: string }>;
      spawnWorker?: SpawnWorker;
    },
  ) {}

  private get python() {
    return join(this.dir, "venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
  }

  private get ready() {
    return existsSync(this.python) && existsSync(join(this.dir, "installed-ok"));
  }

  private get env(): NodeJS.ProcessEnv {
    // Everything it downloads stays in the engine's folder, not in the user's home.
    return { ...process.env, UV_PYTHON_INSTALL_DIR: join(this.dir, "python"), UV_CACHE_DIR: join(this.dir, "uv-cache"), HF_HOME: join(this.dir, "hf"), PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1", PYTHONUNBUFFERED: "1" };
  }

  private add(line: string) {
    this.state.log.push(line.slice(0, 300));
    if (this.state.log.length > 300) this.state.log.splice(0, 100);
  }

  /** @returns Whether it is set up, what it does now, the model it uses, and the download a setup needs. */
  async status(): Promise<HebrewTtsState> {
    const ck = await this.opts.checkpoint().catch(() => ({}) as { model?: string });
    const installed = this.ready;
    const sizeGb = (installed ? 0 : F5_ENGINE_GB) + (ck.model || existsSync(join(this.dir, "model-ok")) ? 0 : F5_MODEL_GB);
    return {
      installed,
      ...(this.state.phase ? { phase: this.state.phase } : {}),
      ...(this.state.message ? { message: this.state.message } : {}),
      ...(ck.model ? { model: basename(ck.model) } : {}),
      loaded: this.loaded,
      sizeGb: Math.round(sizeGb * 10) / 10,
      log: this.state.log.slice(-40),
    };
  }

  private run(cmd: string, args: string[], timeoutMs = 60 * 60_000): Promise<string> {
    return new Promise((ok, fail) => {
      const p = spawn(cmd, args, { env: this.env, windowsHide: true });
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
   * Installs Python 3.11, PyTorch (CUDA on an NVIDIA card), f5-tts and Phonikud once, then loads the model one time so
   * the vocoder, the nikud model and (when it is not on the computer) the fine-tune download now, not at the first
   * sentence. Runs only when the user taps "Set it up".
   */
  install(): Promise<void> {
    this.installing ??= (async () => {
      Object.assign(this.state, { phase: "installing", message: "Setting up the Hebrew voice (Python, PyTorch and F5-TTS, about 4 GB once)…" });
      try {
        const uv = await this.opts.uv();
        await mkdir(this.dir, { recursive: true });
        if (!existsSync(this.python)) await this.run(uv, ["venv", "--python", "3.11", "--seed", join(this.dir, "venv")]);
        const nvidia = process.platform !== "darwin" && (await this.opts.nvidia().catch(() => false));
        // torchaudio 2.9 reads audio through torchcodec, which needs FFmpeg's DLLs on Windows: 2.7 reads it itself.
        const index = process.platform === "darwin" ? [] : ["--index-url", `https://download.pytorch.org/whl/${nvidia ? "cu128" : "cpu"}`];
        await this.run(uv, ["pip", "install", "--python", this.python, "torch==2.7.1", "torchaudio==2.7.1", ...index]);
        // The same pins keep the build above (2.7.1 matches 2.7.1+cu128), so f5-tts does not pull another PyTorch.
        await this.run(uv, ["pip", "install", "--python", this.python, "f5-tts", "phonikud-onnx", "torch==2.7.1", "torchaudio==2.7.1"]);
        await writeFile(join(this.dir, "worker.py"), WORKER);
        Object.assign(this.state, { message: "Downloading the voice's models (the first time only)…" });
        await this.run(this.python, [join(this.dir, "worker.py"), JSON.stringify({ ...(await this.workerConfig()), prepare: true })]);
        if (!(await this.opts.checkpoint().catch(() => ({}) as { model?: string })).model) await writeFile(join(this.dir, "model-ok"), F5_HEBREW_REPO);
        await writeFile(join(this.dir, "installed-ok"), "f5-tts\n");
        Object.assign(this.state, { phase: undefined, message: "Ready." });
      } catch (e) {
        Object.assign(this.state, { phase: "error", message: (e as Error).message });
        throw e;
      } finally {
        this.installing = undefined;
      }
    })();
    return this.installing;
  }

  private async workerConfig(): Promise<Record<string, string>> {
    const ck = await this.opts.checkpoint().catch(() => ({}) as { model?: string; vocab?: string });
    return { repo: F5_HEBREW_REPO, ...(ck.model ? { model: ck.model } : {}), ...(ck.model && ck.vocab ? { vocab: ck.vocab } : {}) };
  }

  /** Starts the Python worker if it is not running, and hooks its answers. */
  private async worker(): Promise<ChildProcess> {
    if (this.child && this.child.exitCode === null && !this.child.killed) return this.child;
    await writeFile(join(this.dir, "worker.py"), WORKER);
    const args = [join(this.dir, "worker.py"), JSON.stringify(await this.workerConfig())];
    const child = (this.opts.spawnWorker ?? ((py, a, env) => spawn(py, a, { env, windowsHide: true })))(this.python, args, this.env);
    this.child = child;
    this.loaded = false;
    createInterface({ input: child.stdout! }).on("line", (l) => {
      if (l.startsWith("LOADED")) this.loaded = true;
      const a = parseWorkerLine(l);
      if (!a) return this.add(l);
      const w = a.id ? this.waiting.get(a.id) : undefined;
      if (!w || !a.id) return;
      this.waiting.delete(a.id);
      if (a.ok) w.ok();
      else w.fail(new Error(a.error || "The Hebrew voice did not answer."));
    });
    if (child.stderr) createInterface({ input: child.stderr }).on("line", (l) => this.add(l));
    child.on("exit", (code) => {
      if (this.child === child) {
        this.child = undefined;
        this.loaded = false;
      }
      for (const [, w] of this.waiting) w.fail(new Error(`The Hebrew voice stopped (code ${code}). ${this.state.log.slice(-2).join(" ")}`.trim()));
      this.waiting.clear();
    });
    child.on("error", (e) => this.add(`could not start: ${e.message}`));
    return child;
  }

  /**
   * Reads Hebrew text aloud. One sentence at a time (voice mode sends sentences as they come); the model stays loaded.
   *
   * @param text - Hebrew text, without nikud (Phonikud adds it).
   * @param speed - 1 is normal.
   * @param ref - A voice to copy (a WAV of a few seconds) and what it says; the built-in reference voice when absent.
   * @returns The speech as WAV (24 kHz).
   */
  async speak(text: string, speed = 1, ref?: { wav: string; text: string }): Promise<Buffer> {
    if (!this.ready) throw Object.assign(new Error("The Hebrew voice is not set up yet."), { statusCode: 409, code: "needs-setup" });
    if (this.installing) throw Object.assign(new Error("The Hebrew voice is being set up; try again soon."), { statusCode: 409, code: "busy" });
    const say = text.trim().slice(0, 4000);
    if (!say) throw Object.assign(new Error("No text"), { statusCode: 400 });
    const run = this.queue.then(() => this.synth(say, Math.max(0.5, Math.min(2, speed || 1)), ref));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async synth(text: string, speed: number, ref?: { wav: string; text: string }): Promise<Buffer> {
    clearTimeout(this.idle);
    const child = await this.worker();
    const id = randomUUID();
    const out = join(this.dir, `say-${id}.wav`);
    Object.assign(this.state, { phase: this.loaded ? "speaking" : "loading", message: this.loaded ? "Speaking…" : "Loading the Hebrew voice…" });
    try {
      // The first sentence also loads the model (tens of seconds); after that a sentence takes about a second.
      await new Promise<void>((ok, fail) => {
        const timer = setTimeout(() => (this.waiting.delete(id), fail(new Error("The Hebrew voice took too long."))), (this.loaded ? 2 : 6) * 60_000);
        this.waiting.set(id, { ok: () => (clearTimeout(timer), ok()), fail: (e) => (clearTimeout(timer), fail(e)) });
        child.stdin!.write(`${JSON.stringify({ id, text, speed, out, ...(ref ? { ref: ref.wav, refText: ref.text } : {}) })}\n`);
      });
      Object.assign(this.state, { phase: undefined, message: "Ready." });
      return await readFile(out);
    } catch (e) {
      Object.assign(this.state, { phase: "error", message: (e as Error).message });
      throw e;
    } finally {
      await rm(out, { force: true }).catch(() => undefined);
      this.idle = setTimeout(() => this.stop(), IDLE_MS);
      this.idle.unref?.();
    }
  }

  /** Ends the Python process (frees the graphics card); the next sentence starts it again. */
  stop(): void {
    clearTimeout(this.idle);
    const c = this.child;
    this.child = undefined;
    this.loaded = false;
    if (c && c.exitCode === null) {
      c.stdin?.end();
      c.kill();
    }
  }
}

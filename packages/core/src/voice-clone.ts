import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * A voice of her own (Roee, 2026-11-16): Chatterbox Multilingual (Resemble AI, MIT licence) speaks 23 languages,
 * Hebrew among them, in a voice copied from a short clip (10–30 seconds), with no training. It runs in its own Python
 * (about 4 GB once: PyTorch with CUDA and chatterbox-tts), on the graphics card, or on the processor when the card is
 * full (slower).
 *
 * A clip is kept only with a yes that it is her own voice or one she may use; the voices stay in KesherAI's folder.
 */

export const CLONE_LANGS = ["he", "en", "ar", "ru", "fr", "de", "es", "it", "pt", "nl", "pl", "sv", "da", "no", "fi", "el", "tr", "zh", "ja", "ko", "hi", "ms", "sw"] as const;

/** What the voice engine is doing. */
export interface CloneState {
  installed: boolean;
  phase?: "installing" | "speaking" | "error";
  message?: string;
  log: string[];
}

const SCRIPT = `import json, sys, torch, torchaudio
from chatterbox.mtl_tts import ChatterboxMultilingualTTS
a = json.loads(sys.argv[1])
device = "cuda" if torch.cuda.is_available() else "cpu"
try:
    model = ChatterboxMultilingualTTS.from_pretrained(device=device)
except torch.cuda.OutOfMemoryError:
    device = "cpu"
    model = ChatterboxMultilingualTTS.from_pretrained(device="cpu")
wav = model.generate(a["text"], language_id=a["lang"], audio_prompt_path=a["voice"])
torchaudio.save(a["out"], wav, model.sr)
print("DONE", device)
`;

/** Installs Chatterbox once, keeps voices, and speaks text in one of them. */
export class VoiceCloner {
  private state: CloneState = { installed: false, log: [] };
  private busy?: Promise<unknown>;

  /**
   * @param dir - engines/chatterbox.
   * @param uv - The path to uv (installs it if needed).
   */
  constructor(
    private readonly dir: string,
    private readonly uv: () => Promise<string>,
  ) {}

  private get python() {
    return join(this.dir, "venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
  }

  private voicesDir() {
    return join(this.dir, "voices");
  }

  /** @returns The engine's state and the voices kept. */
  async status(): Promise<CloneState & { voices: string[] }> {
    const voices = (await readdir(this.voicesDir()).catch(() => [] as string[])).filter((f) => f.endsWith(".wav")).map((f) => f.slice(0, -4));
    return { ...this.state, installed: existsSync(this.python), log: this.state.log.slice(-40), voices };
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

  /** Installs Python 3.11, PyTorch with CUDA and chatterbox-tts in their own folder (about 4 GB, once). */
  install(): Promise<unknown> {
    this.busy ??= (async () => {
      Object.assign(this.state, { phase: "installing", message: "Setting up Python, PyTorch and Chatterbox (about 4 GB, once)…" });
      try {
        const uv = await this.uv();
        const env = { ...process.env, UV_PYTHON_INSTALL_DIR: join(this.dir, "python"), UV_CACHE_DIR: join(this.dir, "uv-cache") };
        await mkdir(this.dir, { recursive: true });
        await this.run(uv, ["venv", "--python", "3.11", "--seed", join(this.dir, "venv")], env);
        // PyTorch with CUDA first (the version chatterbox-tts asks for), so pip does not take the processor-only build.
        await this.run(uv, ["pip", "install", "--python", this.python, "torch==2.6.0", "torchaudio==2.6.0", "--index-url", "https://download.pytorch.org/whl/cu124"], env);
        await this.run(uv, ["pip", "install", "--python", this.python, "chatterbox-tts"], env);
        await this.fixWatermark(uv, env);
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
   * The audio watermark (Resemble's Perth, which marks speech as made by AI) loads its model through pkg_resources,
   * which setuptools 81 removed; without it Chatterbox stops. Pins setuptools below 81 once (also on engines set up
   * before this fix).
   */
  private async fixWatermark(uv: string, env: NodeJS.ProcessEnv): Promise<void> {
    const mark = join(this.dir, "watermark-ok");
    if (existsSync(mark)) return;
    await this.run(uv, ["pip", "install", "--python", this.python, "setuptools<81"], env);
    await writeFile(mark, "setuptools<81\n");
  }

  /**
   * Keeps a voice clip (WAV, 5 seconds to 2 minutes) under a name.
   *
   * @param name - The voice's name.
   * @param wav - The clip.
   * @param consent - She said it is her voice or one she may use.
   */
  async addVoice(name: string, wav: Buffer, consent: boolean): Promise<string> {
    if (!consent) throw Object.assign(new Error("Keep a voice only when it is yours or you have the person's permission."), { statusCode: 400 });
    const id = name.trim().replace(/[^\p{L}\p{N} _-]+/gu, "").replace(/\s+/g, "-").slice(0, 40);
    if (!id) throw Object.assign(new Error("Give the voice a name."), { statusCode: 400 });
    if (wav.length < 5 * 16000 * 2 || wav.length > 2 * 60 * 48000 * 4 + 1000 || wav.subarray(0, 4).toString() !== "RIFF") throw Object.assign(new Error("Send a WAV clip of 5 seconds to 2 minutes."), { statusCode: 400 });
    await mkdir(this.voicesDir(), { recursive: true });
    await writeFile(join(this.voicesDir(), `${id}.wav`), wav);
    return id;
  }

  /** Deletes a kept voice. */
  async removeVoice(name: string): Promise<void> {
    if (!/^[\p{L}\p{N} _-]{1,40}$/u.test(name)) throw Object.assign(new Error("No such voice."), { statusCode: 404 });
    await rm(join(this.voicesDir(), `${name}.wav`), { force: true });
  }

  /**
   * Speaks text in a kept voice.
   *
   * @returns The speech as WAV.
   */
  async say(voice: string, text: string, lang: string): Promise<Buffer> {
    if (!existsSync(this.python)) throw Object.assign(new Error("Set up the voice engine first (one download of about 4 GB)."), { statusCode: 409 });
    if (this.busy) throw Object.assign(new Error("The voice engine is busy; try again in a moment."), { statusCode: 409 });
    if (!(CLONE_LANGS as readonly string[]).includes(lang)) throw Object.assign(new Error("That language is not supported."), { statusCode: 400 });
    const ref = join(this.voicesDir(), `${voice}.wav`);
    if (!/^[\p{L}\p{N} _-]{1,40}$/u.test(voice) || !existsSync(ref)) throw Object.assign(new Error("No such voice."), { statusCode: 404 });
    const t = text.trim().slice(0, 1500);
    if (!t) throw Object.assign(new Error("Write something to say."), { statusCode: 400 });
    if (!existsSync(join(this.dir, "watermark-ok"))) {
      Object.assign(this.state, { phase: "installing", message: "Fixing the voice engine (one small download)…" });
      await this.fixWatermark(await this.uv(), { ...process.env, UV_PYTHON_INSTALL_DIR: join(this.dir, "python"), UV_CACHE_DIR: join(this.dir, "uv-cache") });
    }
    const script = join(this.dir, "kesher_say.py");
    await writeFile(script, SCRIPT);
    const out = join(this.dir, `say-${Date.now()}.wav`);
    Object.assign(this.state, { phase: "speaking", message: "Speaking…" });
    const job = this.run(this.python, [script, JSON.stringify({ text: t, lang, voice: ref, out })], { ...process.env, HF_HOME: join(this.dir, "hf"), PYTHONUTF8: "1" }, 10 * 60_000);
    this.busy = job;
    try {
      await job;
      const wav = await readFile(out);
      await rm(out, { force: true });
      Object.assign(this.state, { phase: undefined, message: "Ready." });
      return wav;
    } catch (e) {
      Object.assign(this.state, { phase: "error", message: (e as Error).message });
      throw e;
    } finally {
      this.busy = undefined;
    }
  }
}

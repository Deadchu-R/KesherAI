import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Train models, step 3 (experimental): a LoRA for a small chat model on a
 * dataset made in step 2, with unsloth (Apache-2.0) in a Python environment
 * of its own. The result is merged and saved as a GGUF file in the models
 * folder, so it shows with the chat models.
 *
 * Needs an NVIDIA card with 8 GB or more, and a one-time download of about
 * 4 GB (PyTorch and unsloth) plus the base model (2–3 GB).
 */

/** Small instruct models unsloth prepares in 4 bits (each has its own licence, shown on its page). */
export const CHAT_BASES = [
  { id: "unsloth/Llama-3.2-3B-Instruct-bnb-4bit", title: "Llama 3.2 3B (Meta licence)", gb: 2.2 },
  { id: "unsloth/Qwen2.5-3B-Instruct-bnb-4bit", title: "Qwen 2.5 3B (Qwen licence)", gb: 2.1 },
  { id: "unsloth/gemma-3-4b-it-unsloth-bnb-4bit", title: "Gemma 3 4B (Gemma terms)", gb: 3.2 },
];

/** What the trainer is doing. */
export interface ChatTrainState {
  installed: boolean;
  phase?: "installing" | "training" | "done" | "error";
  message?: string;
  log: string[];
  /** The GGUF made last, in the models folder. */
  result?: string;
}

const SCRIPT = String.raw`
import json, sys, os
args = json.loads(sys.argv[1])
from unsloth import FastLanguageModel
from unsloth.chat_templates import get_chat_template, train_on_responses_only
from datasets import load_dataset
from trl import SFTTrainer, SFTConfig
model, tokenizer = FastLanguageModel.from_pretrained(model_name=args["base"], max_seq_length=2048, load_in_4bit=True)
model = FastLanguageModel.get_peft_model(model, r=args["rank"], lora_alpha=args["rank"], lora_dropout=0, target_modules=["q_proj","k_proj","v_proj","o_proj","gate_proj","up_proj","down_proj"], use_gradient_checkpointing="unsloth")
ds = load_dataset("json", data_files=args["dataset"], split="train")
ds = ds.map(lambda b: {"text": [tokenizer.apply_chat_template(m, tokenize=False) for m in b["messages"]]}, batched=True)
trainer = SFTTrainer(model=model, tokenizer=tokenizer, train_dataset=ds, args=SFTConfig(dataset_text_field="text", per_device_train_batch_size=2, gradient_accumulation_steps=4, max_steps=args["steps"], learning_rate=2e-4, logging_steps=5, output_dir=args["out"] + "/checkpoints", report_to="none"))
trainer.train()
model.save_pretrained(args["out"] + "/lora"); tokenizer.save_pretrained(args["out"] + "/lora")
print("KESHER: LoRA saved", flush=True)
try:
    model.save_pretrained_gguf(args["out"] + "/gguf", tokenizer, quantization_method="q4_k_m")
    print("KESHER: GGUF saved", flush=True)
except Exception as e:
    print("KESHER: GGUF export failed: " + str(e), flush=True)
`;

/** Installs unsloth once, and trains. */
export class ChatTrainer {
  private state: ChatTrainState = { installed: false, log: [] };
  private busy?: Promise<void>;

  /**
   * @param dir - engines/unsloth.
   * @param opts - uv, where models go.
   * @param opts.uv - The path to uv (installs it if needed).
   * @param opts.modelsDir - The models folder (the GGUF goes in chat/).
   */
  constructor(
    private readonly dir: string,
    private readonly opts: { uv: () => Promise<string>; modelsDir: () => string },
  ) {
    this.state.installed = existsSync(this.python);
  }

  private get python() {
    return join(this.dir, "venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
  }

  /** @returns What it is doing (the last 60 log lines). */
  status(): ChatTrainState {
    return { ...this.state, installed: existsSync(this.python), log: this.state.log.slice(-60) };
  }

  private add(line: string) {
    this.state.log.push(line.slice(0, 300));
    if (this.state.log.length > 400) this.state.log.splice(0, 100);
  }

  private run(cmd: string, args: string[], env: NodeJS.ProcessEnv): Promise<void> {
    return new Promise((ok, fail) => {
      const p = spawn(cmd, args, { env, windowsHide: true });
      const on = (b: Buffer) => b.toString().split(/\r?\n/).filter(Boolean).forEach((l) => this.add(l));
      p.stdout.on("data", on);
      p.stderr.on("data", on);
      p.on("error", fail);
      p.on("close", (code) => (code === 0 ? ok() : fail(new Error(`${cmd.split(/[\\/]/).pop()} stopped (code ${code}); see the log.`))));
    });
  }

  /** Installs Python 3.12, PyTorch (CUDA) and unsloth in their own folder (about 4 GB, once). */
  install(): Promise<void> {
    this.busy ??= (async () => {
      Object.assign(this.state, { phase: "installing", message: "Setting up Python, PyTorch and unsloth (about 4 GB, once)…" });
      try {
        const uv = await this.opts.uv();
        const env = { ...process.env, UV_PYTHON_INSTALL_DIR: join(this.dir, "python"), UV_CACHE_DIR: join(this.dir, "uv-cache") };
        await mkdir(this.dir, { recursive: true });
        await this.run(uv, ["venv", "--python", "3.12", "--seed", join(this.dir, "venv")], env);
        await this.run(uv, ["pip", "install", "--python", this.python, "torch", "--index-url", "https://download.pytorch.org/whl/cu128"], env);
        await this.run(uv, ["pip", "install", "--python", this.python, "unsloth", "datasets", "trl"], env);
        Object.assign(this.state, { phase: undefined, message: "Ready to train.", installed: true });
      } catch (e) {
        Object.assign(this.state, { phase: "error", message: (e as Error).message });
      } finally {
        this.busy = undefined;
      }
    })();
    return this.busy;
  }

  /**
   * Trains a LoRA on a dataset and saves a GGUF with the chat models.
   *
   * @param req - What to train.
   * @param req.name - The new model's name.
   * @param req.dataset - A dataset file from step 2.
   * @param req.base - One of CHAT_BASES.
   * @param req.steps - Training steps (default 200).
   * @param req.rank - LoRA rank (default 16).
   * @throws Error when it cannot start.
   */
  async train(req: { name: string; dataset: string; base: string; steps?: number; rank?: number }): Promise<void> {
    if (this.busy) throw new Error("The trainer is busy; wait for it to finish.");
    if (!existsSync(this.python)) throw new Error("Set up the trainer first (one download of about 4 GB).");
    if (!CHAT_BASES.some((b) => b.id === req.base)) throw new Error("Choose a base model from the list.");
    if (!existsSync(req.dataset)) throw new Error("That dataset was not found.");
    const out = join(this.dir, "runs", req.name);
    await mkdir(out, { recursive: true });
    const script = join(this.dir, "kesher_train.py");
    await writeFile(script, SCRIPT);
    const args = JSON.stringify({ base: req.base, dataset: req.dataset, out, steps: Math.max(20, Math.min(5000, Math.round(req.steps ?? 200))), rank: Math.max(4, Math.min(64, Math.round(req.rank ?? 16))) });
    this.state.log = [];
    Object.assign(this.state, { phase: "training", message: `Training ${req.name}…`, result: undefined });
    this.busy = (async () => {
      try {
        await this.run(this.python, [script, args], { ...process.env, HF_HOME: join(this.dir, "hf"), PYTHONUTF8: "1" });
        const gguf = (await readdir(join(out, "gguf")).catch(() => [] as string[])).find((f) => f.endsWith(".gguf"));
        if (gguf) {
          const dest = join(this.opts.modelsDir(), "chat");
          await mkdir(dest, { recursive: true });
          const file = `${req.name}-q4_k_m.gguf`;
          await copyFile(join(out, "gguf", gguf), join(dest, file));
          Object.assign(this.state, { phase: "done", message: `Done: "${req.name}" is with your chat models (Models → Chat).`, result: file });
        } else {
          Object.assign(this.state, { phase: "done", message: `The LoRA is saved (${join(out, "lora")}), but turning it into a GGUF failed; see the log.` });
        }
      } catch (e) {
        const msg = (e as Error).message;
        Object.assign(this.state, { phase: "error", message: this.state.log.some((l) => /out of memory|CUDA error: out/i.test(l)) ? "The graphics card ran out of memory: try a smaller base model, fewer steps or a lower rank." : msg });
      } finally {
        this.busy = undefined;
      }
    })();
  }
}

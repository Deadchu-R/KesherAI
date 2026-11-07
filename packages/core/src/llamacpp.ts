import { spawn, type ChildProcess } from "node:child_process";
import { basename } from "node:path";

/** Current state of the managed llama-server. */
export interface LlamaServerStatus {
  running: boolean;
  /** GGUF file loaded, if running. */
  modelPath?: string;
  /** Last lines of its output, for the UI's log panel. */
  log: string[];
}

/**
 * Starts and stops llama.cpp's `llama-server` for a GGUF file the user
 * downloaded. The running server is registered as the `llamacpp`
 * OpenAI-compatible provider, so chat works with it like any other model.
 *
 * One model at a time; loading another stops the previous one.
 */
export class LlamaServerManager {
  private proc?: ChildProcess;
  private modelPath?: string;
  private readonly log: string[] = [];

  /**
   * @param binaryPath - Path of `llama-server`.
   * @param port - Port to listen on (localhost only).
   * @param extraArgs - Extra CLI arguments, e.g. `["-ngl", "99"]`.
   */
  constructor(
    private readonly binaryPath: string,
    private readonly port: number,
    private readonly extraArgs: string[] = [],
  ) {}

  /** @returns Whether it runs, which model, and recent output. */
  status(): LlamaServerStatus {
    return { running: !!this.proc && this.proc.exitCode === null, ...(this.modelPath ? { modelPath: this.modelPath } : {}), log: [...this.log] };
  }

  /**
   * Starts llama-server with a model and waits until it answers `/health`.
   *
   * @param modelPath - Absolute path of a `.gguf` file.
   * @param timeoutMs - How long to wait for the model to load.
   * @throws Error if the process exits or does not become healthy in time.
   */
  async load(modelPath: string, timeoutMs = 180_000): Promise<void> {
    await this.stop();
    this.log.length = 0;
    const alias = basename(modelPath).replace(/\.gguf$/i, "");
    const proc = spawn(
      this.binaryPath,
      ["-m", modelPath, "--host", "127.0.0.1", "--port", String(this.port), "--alias", alias, ...this.extraArgs],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    this.proc = proc;
    this.modelPath = modelPath;
    const onData = (buf: Buffer) => {
      this.log.push(...buf.toString().split("\n").filter(Boolean));
      if (this.log.length > 200) this.log.splice(0, this.log.length - 200);
    };
    proc.stdout?.on("data", onData);
    proc.stderr?.on("data", onData);

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (proc.exitCode !== null) throw new Error(`llama-server exited with code ${proc.exitCode}: ${this.log.slice(-5).join(" | ")}`);
      const ok = await fetch(`http://127.0.0.1:${this.port}/health`).then((r) => r.ok).catch(() => false);
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
    proc.kill("SIGTERM");
    await new Promise((r) => {
      const t = setTimeout(() => { proc.kill("SIGKILL"); r(undefined); }, 5000);
      proc.once("exit", () => { clearTimeout(t); r(undefined); });
    });
  }
}

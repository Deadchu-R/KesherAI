/**
 * The small model behind the run guard's watchdog (agent-watch.ts), on loan: it is loaded only for a check, runs on the
 * CPU (llama.cpp `-ngl 0`) so it never takes memory from the main model or ComfyUI, and is unloaded after a short idle.
 * Only when a CPU answer is slower than {@link SLOW_MS} are the next checks run on the GPU.
 *
 * The engine and the clock come in as parameters, so tests use a fake engine and timers.
 */

/** A CPU answer slower than this moves the next checks to the GPU (ms). */
export const SLOW_MS = 20_000;
/** The model stays loaded this long after a check (ms), then it is unloaded. */
export const IDLE_MS = 60_000;

/** What the watchdog needs from a llama.cpp instance. */
export interface WatchEngine {
  load(modelPath: string): Promise<void>;
  stop(reason: string): Promise<void>;
  /** Asks it one question; the answer text. */
  ask(system: string, prompt: string, signal: AbortSignal): Promise<string>;
}

/** The pieces of {@link WatchdogModel}. */
export interface WatchdogDeps {
  /** A fresh instance: CPU only (`-ngl 0`) or with the usual GPU plan. Undefined: this build cannot run a second one. */
  make: (cpu: boolean) => WatchEngine | undefined | Promise<WatchEngine | undefined>;
  /** The GGUF file of the small model, or undefined when it is not on this computer. */
  modelPath: () => Promise<string | undefined>;
  /** Another model already loaded that may be used when no second instance can run (the router model), with its ask. */
  loaded?: () => ((system: string, prompt: string, signal: AbortSignal) => Promise<string>) | undefined;
  now?: () => number;
  /** Timer functions (tests pass fakes). */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
  /** Logs one line (once per reason). */
  log?: (line: string) => void;
}

/** The loan: {@link WatchdogModel.ask} loads on demand, {@link WatchdogModel.stop} frees it. */
export class WatchdogModel {
  private engine: WatchEngine | undefined;
  private onGpu = false;
  private timer: unknown;
  private logged = new Set<string>();
  private chain: Promise<unknown> = Promise.resolve();

  /** @param d - The engine factory, the model file and the clock. */
  constructor(private readonly d: WatchdogDeps) {}

  /** Whether the next checks run on the GPU (a CPU answer was too slow). */
  get gpu(): boolean {
    return this.onGpu;
  }

  /**
   * One check: loads the model when it is not loaded, asks, and schedules the unload.
   *
   * @returns The answer text, or undefined when the check was skipped (no model file, no engine, a failure).
   */
  ask(system: string, prompt: string, signal: AbortSignal): Promise<string | undefined> {
    // One check at a time: the instance is small and serves one.
    const run = this.chain.then(() => this.once(system, prompt, signal));
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async once(system: string, prompt: string, signal: AbortSignal): Promise<string | undefined> {
    const now = this.d.now ?? Date.now;
    this.cancelIdle();
    try {
      if (!this.engine) {
        const file = await this.d.modelPath();
        if (!file) return this.skip("not-found", "The watchdog model is not on this computer: checks skipped.");
        const e = await this.d.make(!this.onGpu);
        if (!e) {
          // No second instance possible: use the router model only when it is already loaded, else skip.
          const reuse = this.d.loaded?.();
          return reuse ? await reuse(system, prompt, signal) : this.skip("no-second", "No second llama.cpp instance can run and the router model is not loaded: watchdog checks skipped.");
        }
        await e.load(file);
        this.engine = e;
      }
      const t0 = now();
      const text = await this.engine.ask(system, prompt, signal);
      // A slow CPU answer: the next load uses the GPU.
      if (!this.onGpu && now() - t0 > SLOW_MS) {
        this.onGpu = true;
        await this.release("slow on the CPU");
      }
      return text;
    } catch {
      await this.release("failed");
      return undefined;
    } finally {
      if (this.engine) this.scheduleIdle();
    }
  }

  private skip(key: string, line: string): undefined {
    if (!this.logged.has(key)) {
      this.logged.add(key);
      this.d.log?.(line);
    }
    return undefined;
  }

  private scheduleIdle(): void {
    this.cancelIdle();
    this.timer = (this.d.setTimer ?? ((fn, ms) => {
      const h = setTimeout(fn, ms);
      h.unref?.();
      return h;
    }))(() => void this.release("idle"), IDLE_MS);
  }

  private cancelIdle(): void {
    if (this.timer !== undefined) (this.d.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>)))(this.timer);
    this.timer = undefined;
  }

  private async release(reason: string): Promise<void> {
    this.cancelIdle();
    const e = this.engine;
    this.engine = undefined;
    await e?.stop(reason).catch(() => undefined);
  }

  /** Unloads the model now (a run ended, the app closes). */
  stop(): Promise<void> {
    return this.release("unloaded");
  }
}

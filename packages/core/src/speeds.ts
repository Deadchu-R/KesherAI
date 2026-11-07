import { readFile, writeFile } from "node:fs/promises";

/**
 * Measured writing speed per model on this computer (tokens per second,
 * averaged over recent answers), shown instead of an estimate once known.
 */
export class Speeds {
  private data: Record<string, { tps: number; n: number; at: string }> = {};
  private loaded = false;
  private timer?: NodeJS.Timeout;

  /** @param file - Where they are kept (`speeds.json`). */
  constructor(private readonly file: string) {}

  private async load() {
    if (this.loaded) return;
    this.loaded = true;
    try {
      this.data = JSON.parse(await readFile(this.file, "utf8")) as typeof this.data;
    } catch {
      this.data = {};
    }
  }

  /** Model ids and file names that mean the same model, e.g. `llamacpp/Qwen3-8B-Q4_K_M` and `Qwen3-8B-Q4_K_M`. */
  static keys(modelId: string): string[] {
    const last = modelId.split("/").pop() ?? modelId;
    return [modelId, last.replace(/\.gguf$/i, "").toLowerCase()];
  }

  /**
   * Adds one answer's speed.
   *
   * @param modelId - The model.
   * @param tokens - About how many tokens it wrote.
   * @param ms - How long writing took.
   */
  async record(modelId: string, tokens: number, ms: number): Promise<void> {
    await this.load();
    const tps = tokens / (ms / 1000);
    if (!Number.isFinite(tps) || tps <= 0) return;
    for (const k of Speeds.keys(modelId)) {
      const old = this.data[k];
      // A running average that follows recent runs (new settings, other cards).
      this.data[k] = { tps: old ? old.tps * 0.7 + tps * 0.3 : tps, n: (old?.n ?? 0) + 1, at: new Date().toISOString() };
    }
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void writeFile(this.file, JSON.stringify(this.data, null, 2)).catch(() => undefined), 2000);
    this.timer.unref?.();
  }

  /**
   * @param modelOrFile - A model id or a model file's name.
   * @returns The measured speed, if there is one.
   */
  async get(modelOrFile: string): Promise<{ tps: number; n: number } | undefined> {
    await this.load();
    for (const k of Speeds.keys(modelOrFile)) if (this.data[k]) return { tps: Math.round(this.data[k]!.tps * 10) / 10, n: this.data[k]!.n };
    return undefined;
  }
}

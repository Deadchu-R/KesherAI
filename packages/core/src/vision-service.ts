/**
 * The local vision models for browser and computer control (Phase 6): where they are saved (the heavy-data drive),
 * whether they are installed, their download with the app's own download manager, and the llama.cpp server that runs
 * the chosen one in a slot of its own (the chat's model stays loaded). It unloads itself after a quiet while.
 *
 * Nothing here downloads by itself: installs start from the Install button (installables.ts) or the Models screen.
 */
import { existsSync } from "node:fs";
import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { listHubFiles, type DownloadManager, type HubFile } from "@kesher/downloads";
import { VISION_MODELS, pickVisionModel, type VisionChoice, type VisionModel } from "@kesher/shared";
import { suggestHeavyDir } from "./heavy-folder.js";
import { LlamaEngine, freePort, waitForDownload } from "./llamacpp.js";
import { VisionGrounder, type GroundResult, type VisionAnswer, type VisionAsk } from "./vision-ground.js";
import type { BenchRun } from "./vision-bench.js";

/** The two files a vision model needs on disk. */
export interface VisionFiles {
  model: string;
  mmproj: string;
}

/** What the chat and Settings say about a missing model: which, how big, and where it would be saved. */
export interface VisionMissing {
  installId: string;
  name: string;
  sizeGb: number;
  where: string;
}

/** The finder the tools use (computer_find, browser_find_visual). */
export interface Grounding {
  /** The model that would answer now, or undefined when none is installed. */
  model(): VisionModel | undefined;
  /** What to offer when none is installed. */
  missing(): VisionMissing;
  /** Finds a thing on a picture (loads the model on first use). */
  ground(req: { png: Buffer; width: number; height: number; query: string; signal?: AbortSignal }): Promise<GroundResult>;
}

/** The folder the vision models live in, by repository, under a base folder. */
export const VISION_FOLDER = "gui-vision";
/** The vision slot unloads after this long without a request. */
const IDLE_MS = 10 * 60_000;
/** How many test runs are kept. */
const KEEP_RUNS = 10;

/**
 * The file a pattern picks from a repository's files.
 *
 * @param files - The repository's files.
 * @param pattern - The catalog's pattern (case-insensitive).
 * @returns The first match, preferring F16 and then smaller names for projectors.
 */
export function pickHubFile(files: readonly HubFile[], pattern: string): HubFile | undefined {
  const re = new RegExp(pattern, "i");
  const all = files.filter((f) => re.test(f.path.split("/").pop() ?? f.path));
  return all.sort((a, b) => Number(/f16/i.test(b.path)) - Number(/f16/i.test(a.path)) || a.path.length - b.path.length)[0];
}

/**
 * The name a file is saved under: projectors always as `mmproj-….gguf`, so the engine's own lookup beside the model
 * finds them too (some repositories ship `….mmproj`).
 *
 * @param path - The file's path in the repository.
 * @param mmproj - Whether it is the projector.
 */
export function savedName(path: string, mmproj: boolean): string {
  // The last part on either separator, with only safe characters: the repository names the file, and a name with a
  // backslash or `..` must never leave the model's folder on Windows (security scan 169).
  const base = (path.split(/[\\/]/).pop() ?? "").replace(/[^\w.+-]/g, "_").replace(/^\.+/, "") || "model.gguf";
  if (!mmproj) return base;
  const stem = base.replace(/\.(gguf|mmproj)$/i, "");
  return /^mmproj/i.test(stem) ? `${stem}.gguf` : `mmproj-${stem}.gguf`;
}

/** What the service needs from the app. */
export interface VisionDeps {
  paths: { models: string; root: string; engines: string };
  config: { heavyDir?: string; huggingFaceToken?: string; computer: { visionModel?: VisionChoice }; engines: { llamaVersion?: string } };
  downloads: DownloadManager;
  /** The installed llama-server, if any. */
  binary: () => string | undefined;
  /** Makes a llama.cpp server (tests pass a fake). */
  makeEngine?: (port: number) => VisionEngine;
}

/** What the service needs of a llama.cpp server. */
export interface VisionEngine {
  load(modelPath: string): Promise<void>;
  stop(reason?: string): Promise<void>;
  readonly baseUrl: string;
  readonly apiKey: string;
}

/** The vision models of one app. */
export class VisionService implements Grounding {
  private engine: VisionEngine | undefined;
  private loaded: string | undefined;
  private loading: Promise<void> | undefined;
  private idle: ReturnType<typeof setTimeout> | undefined;
  private installing = new Set<string>();
  readonly grounder: VisionGrounder;
  /** The test that runs now, if any (vision-bench.ts). */
  bench: { running: boolean; done: number; of: number; model?: string; error?: string } = { running: false, done: 0, of: 0 };

  /** @param d - The app's paths, settings, downloads and engine. */
  constructor(private readonly d: VisionDeps) {
    this.grounder = new VisionGrounder((ask) => this.ask(ask));
  }

  /** The folder the models are saved in: the heavy-data drive when there is one, else the models folder. */
  dir(): string {
    return join(this.d.config.heavyDir ?? suggestHeavyDir(this.d.paths.models, this.d.paths.root) ?? this.d.paths.models, VISION_FOLDER);
  }

  /**
   * A model's files when both are on disk.
   *
   * @param m - The model.
   */
  async files(m: VisionModel): Promise<VisionFiles | undefined> {
    const folder = join(this.dir(), ...m.repo.split("/"));
    const names = await readdir(folder).catch(() => [] as string[]);
    const model = names.find((n) => new RegExp(m.filePattern, "i").test(n));
    const mmproj = names.find((n) => /^mmproj.*\.gguf$/i.test(n));
    return model && mmproj ? { model: join(folder, model), mmproj: join(folder, mmproj) } : undefined;
  }

  /** Ids of the installed models. */
  async installed(): Promise<string[]> {
    const have = await Promise.all(VISION_MODELS.map(async (m) => ((await this.files(m)) ? m.id : "")));
    return have.filter(Boolean);
  }

  /** Whether a model is downloading now. */
  busy(id: string): boolean {
    return this.installing.has(id);
  }

  private installedNow: string[] = [];

  /** Re-reads which models are installed (the tools answer from this, without touching the disk each call). */
  async refresh(): Promise<string[]> {
    this.installedNow = await this.installed();
    return this.installedNow;
  }

  /** The model the setting means among the installed ones. */
  model(): VisionModel | undefined {
    return pickVisionModel(this.d.config.computer.visionModel ?? "auto", this.installedNow);
  }

  /** The default model's offer (the first in the catalog), or the chosen one's. */
  missing(): VisionMissing {
    const choice = this.d.config.computer.visionModel ?? "auto";
    const m = VISION_MODELS.find((x) => x.id === choice) ?? VISION_MODELS[0]!;
    return { installId: m.installId, name: m.name, sizeGb: Math.round((m.sizeGb + m.mmprojGb) * 10) / 10, where: this.dir() };
  }

  /**
   * Downloads a model's two files into its folder (the app's download manager: progress in Downloads, resumes).
   * Resolves when both are on disk.
   *
   * @param m - The model.
   */
  async install(m: VisionModel): Promise<void> {
    if (this.installing.has(m.id)) return;
    this.installing.add(m.id);
    try {
      const files = await listHubFiles(m.repo, { ...(this.d.config.huggingFaceToken ? { token: this.d.config.huggingFaceToken } : {}) });
      const model = pickHubFile(files, m.filePattern);
      const mmproj = pickHubFile(files.filter((f) => f !== model), m.mmprojPattern);
      if (!model || !mmproj) throw new Error(`${m.repo} has no ${!model ? "model" : "vision"} file that KesherAI knows.`);
      const folder = join(this.dir(), ...m.repo.split("/"));
      await mkdir(folder, { recursive: true });
      for (const [f, isProj] of [[model, false], [mmproj, true]] as const) {
        const dest = join(folder, savedName(f.path, isProj));
        if (existsSync(dest)) continue;
        const job = this.d.downloads.enqueue({ url: f.url, dest, size: f.size, ...(f.sha256 ? { sha256: f.sha256 } : {}), label: `${m.name} · ${f.path}` });
        await waitForDownload(this.d.downloads, job.id);
      }
      await this.refresh();
    } finally {
      this.installing.delete(m.id);
    }
  }

  /** Real sizes before installing: the repository's two files, in GB (undefined when it cannot be read). */
  async sizeGb(m: VisionModel): Promise<number | undefined> {
    const files = await listHubFiles(m.repo, { ...(this.d.config.huggingFaceToken ? { token: this.d.config.huggingFaceToken } : {}) }).catch(() => undefined);
    if (!files) return undefined;
    const model = pickHubFile(files, m.filePattern);
    const mmproj = pickHubFile(files.filter((f) => f !== model), m.mmprojPattern);
    return model && mmproj ? (model.size + mmproj.size) / 1024 ** 3 : undefined;
  }

  /**
   * Loads a model into the vision slot (its own llama.cpp server on a free port), unless it is there already.
   *
   * @param m - The model.
   * @returns How long the load took, ms (0 when it was loaded).
   */
  async load(m: VisionModel): Promise<number> {
    if (this.loaded === m.id && this.engine) return 0;
    while (this.loading) await this.loading.catch(() => undefined);
    if (this.loaded === m.id && this.engine) return 0;
    const files = await this.files(m);
    if (!files) throw new Error(`${m.name} is not installed.`);
    const started = Date.now();
    this.loading = (async () => {
      await this.unload();
      const port = await freePort();
      const binary = this.d.binary();
      if (!this.d.makeEngine && !binary) throw new Error("Install the built-in chat engine first (Models → Chat).");
      const engine =
        this.d.makeEngine?.(port) ??
        new LlamaEngine({
          dir: this.d.paths.engines,
          binaryPath: binary!,
          ...(this.d.config.engines.llamaVersion ? { version: this.d.config.engines.llamaVersion } : {}),
          port,
          // One request at a time, a screenshot's worth of context, the projector named (no guessing).
          args: ["-c", "8192", "--mmproj", files.mmproj],
          parallel: 1,
        });
      await engine.load(files.model);
      this.engine = engine;
      this.loaded = m.id;
    })();
    try {
      await this.loading;
    } finally {
      this.loading = undefined;
    }
    return Date.now() - started;
  }

  /** Frees the graphics card memory the vision slot holds. */
  async unload(): Promise<void> {
    if (this.idle) clearTimeout(this.idle);
    this.idle = undefined;
    const e = this.engine;
    this.engine = undefined;
    this.loaded = undefined;
    await e?.stop("vision model unused");
  }

  /** @returns Which model the vision slot holds now. */
  status(): { loaded?: string } {
    return this.loaded ? { loaded: this.loaded } : {};
  }

  /** One request to the vision slot (OpenAI-style chat with the picture), with the tokens' probabilities. */
  private async ask(a: VisionAsk): Promise<VisionAnswer> {
    await this.load(a.model);
    const e = this.engine!;
    if (this.idle) clearTimeout(this.idle);
    const res = await fetch(`${e.baseUrl.replace(/\/$/, "")}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${e.apiKey}` },
      body: JSON.stringify({
        messages: [
          ...(a.system ? [{ role: "system", content: a.system }] : []),
          { role: "user", content: [...(a.png ? [{ type: "image_url", image_url: { url: `data:${a.mime ?? "image/png"};base64,${a.png.toString("base64")}` } }] : []), { type: "text", text: a.user }] },
        ],
        temperature: 0,
        max_tokens: a.maxTokens ?? 96,
        logprobs: true,
        top_logprobs: 1,
      }),
      ...(a.signal ? { signal: a.signal } : {}),
    });
    this.idle = setTimeout(() => void this.unload(), IDLE_MS);
    this.idle.unref?.();
    if (!res.ok) throw new Error(`The vision model answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const body = (await res.json()) as { choices?: Array<{ message?: { content?: string }; logprobs?: { content?: Array<{ token: string; logprob: number }> } }> };
    const c = body.choices?.[0];
    return { text: c?.message?.content ?? "", ...(c?.logprobs?.content ? { tokens: c.logprobs.content } : {}) };
  }

  /** Finds a thing with the chosen model. */
  async ground(req: { png: Buffer; width: number; height: number; query: string; signal?: AbortSignal }): Promise<GroundResult> {
    const m = this.model() ?? pickVisionModel(this.d.config.computer.visionModel ?? "auto", await this.refresh());
    if (!m) throw new Error("No vision model is installed.");
    return this.grounder.ground(m, req);
  }

  /**
   * One planning question to the local vision model (computer tasks' fallback when the free Gemini key cannot answer):
   * an optional picture and a text prompt, answered in text. The caller runs it through the heavy-job gate.
   *
   * @param req.system - The instructions.
   * @param req.user - The question.
   * @param req.image - The picture, if any.
   * @param req.maxTokens - The longest answer (default 400).
   * @param req.signal - Stop.
   * @returns The model's text.
   */
  async plan(req: { system: string; user: string; image?: { data: Buffer; mimeType: string }; maxTokens?: number; signal?: AbortSignal }): Promise<string> {
    const m = this.model() ?? pickVisionModel(this.d.config.computer.visionModel ?? "auto", await this.refresh());
    if (!m) throw new Error("No vision model is installed.");
    const r = await this.ask({ model: m, system: req.system, user: req.user, maxTokens: req.maxTokens ?? 400, ...(req.image ? { png: req.image.data, mime: req.image.mimeType } : {}), ...(req.signal ? { signal: req.signal } : {}) });
    return r.text;
  }

  /** The saved test runs, newest last. */
  async runs(): Promise<BenchRun[]> {
    try {
      const v = JSON.parse(await readFile(join(this.d.paths.root, "vision-bench.json"), "utf8")) as { runs?: BenchRun[] };
      return Array.isArray(v.runs) ? v.runs : [];
    } catch {
      return [];
    }
  }

  /** Keeps a test run (the last {@link KEEP_RUNS}). */
  async saveRun(run: BenchRun): Promise<void> {
    const runs = [...(await this.runs()), run].slice(-KEEP_RUNS);
    await writeFile(join(this.d.paths.root, "vision-bench.json"), JSON.stringify({ runs }, null, 1));
  }
}

const services = new WeakMap<object, VisionService>();

/**
 * The app's one vision service, by its settings object (the server makes it; routes and tools find it).
 *
 * @param config - The app's settings object.
 * @param make - Makes it the first time.
 */
export function visionServiceOf(config: object, make?: () => VisionService): VisionService | undefined {
  let v = services.get(config);
  if (!v && make) services.set(config, (v = make()));
  return v;
}

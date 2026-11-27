/**
 * The pool of small models on the processor (cpu-pool.ts) made from the real llama.cpp. Two engines, the same
 * behaviour:
 * - router mode (llama.cpp b7400 and newer): one `llama-server --models-preset <ini> --no-models-autoload` that starts
 *   each role's model as its own child process on `POST /models/load` and stops it on `/models/unload`; requests pick
 *   the model by the role's name in their `model` field;
 * - one llama-server per role (older builds, or when the router does not start).
 * Every model runs with `-ngl 0`, `--prio -1` and below-normal process priority (children inherit it), optionally
 * pinned to the X3D chip's CCD without the extra cache (`--cpu-range`).
 */
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { constants as osConstants, cpus, platform, setPriority, totalmem } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { KesherConfig } from "../config.js";
import { CpuPool, CPU_ROLES, type CpuRole, type PoolEngine, type PoolSettings, type RoleSpec } from "../cpu-pool.js";
import type { GameWatch } from "../game-watch.js";
import { LlamaEngine, freePort } from "../llamacpp.js";

/** The first llama.cpp build taken to have router mode (`--models-preset`); an older one gets one server per role. */
export const ROUTER_BUILD = 7400;
/** The model id prefix the translator uses for its CPU model (never a registry provider: calls go through the pool). */
export const CPU_PROVIDER = "llamacpp-cpu";

/** Context per role (tokens): short checks and translations; embeddings read whole passages in one batch. */
const CTX: Record<CpuRole, number> = { chat: 8192, watchdog: 4096, translator: 4096, embeddings: 8192 };

/** A chat message for {@link CpuModels.complete}. */
export interface CpuMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** Where a role's requests go. */
interface Target {
  baseUrl: string;
  apiKey: string;
  model: string;
}

/** An engine that can also say where a loaded role answers. */
interface Backend extends PoolEngine {
  readonly kind: "router" | "instances";
  target(role: CpuRole): Target | undefined;
  stopAll(): Promise<void>;
}

/** The llama.cpp arguments of a role's model, as `[flag, value]` pairs (the router's preset uses the same names). */
export function roleArgs(role: CpuRole, spec: RoleSpec, threads: number, cpuRange?: string): Array<[string, string]> {
  const out: Array<[string, string]> = [["n-gpu-layers", "0"], ["threads", String(threads)], ["ctx-size", String(CTX[role])], ["prio", "-1"]];
  if (spec.embeddings) out.push(["embeddings", "true"], ["ubatch-size", "8192"], ["batch-size", "8192"]);
  if (cpuRange) out.push(["cpu-range", cpuRange]);
  return out;
}

/**
 * The router's preset file: one section per role, named after the role.
 *
 * @param entries - Each role's model, threads and CPU range.
 * @returns The INI text.
 */
export function presetIni(entries: Array<{ role: CpuRole; spec: RoleSpec; threads: number; cpuRange?: string }>): string {
  const lines = ["; Written by KesherAI (CPU models pool); rewritten when a model or its threads change.", ""];
  for (const e of entries) {
    lines.push(`[${e.role}]`, `model = ${e.spec.file}`);
    for (const [k, v] of roleArgs(e.role, e.spec, e.threads, e.cpuRange)) lines.push(`${k} = ${v}`);
    lines.push("");
  }
  return lines.join("\n");
}

/**
 * Whether a llama.cpp build has router mode.
 *
 * @param version - The build tag, e.g. `b12110`.
 */
export function hasRouterMode(version: string | undefined): boolean {
  const n = Number(/b(\d+)/.exec(version ?? "")?.[1]);
  return Number.isFinite(n) && n >= ROUTER_BUILD;
}

/**
 * The X3D chip's CCD without the extra cache, as llama.cpp's `--cpu-range` (logical CPUs): on a two-CCD X3D (12 or 16
 * cores) Windows and Linux number the cache CCD first, so the plain one is the upper half. Undefined elsewhere.
 *
 * @param model - The processor's name.
 * @param physical - Physical cores.
 * @param logical - Logical processors.
 */
export function plainCcdRange(model: string, physical: number, logical: number): string | undefined {
  if (!/X3D/i.test(model) || physical < 12) return undefined;
  return `${Math.floor(logical / 2)}-${logical - 1}`;
}

let physicalCache: number | undefined;

/** The processor's physical cores (read once; half the logical ones when it cannot be read). */
export async function physicalCores(): Promise<number> {
  if (physicalCache) return physicalCache;
  const logical = cpus().length || 1;
  let n: number | undefined;
  try {
    if (platform() === "linux") {
      const ids = new Set<string>();
      for (const d of readdirSync("/sys/devices/system/cpu").filter((x) => /^cpu\d+$/.test(x))) {
        const f = `/sys/devices/system/cpu/${d}/topology/core_cpus_list`;
        if (existsSync(f)) ids.add(readFileSync(f, "utf8").trim());
      }
      n = ids.size || undefined;
    } else if (platform() === "darwin") {
      n = Number((await promisify(execFile)("sysctl", ["-n", "hw.physicalcpu"])).stdout.trim()) || undefined;
    } else if (platform() === "win32") {
      const { stdout } = await promisify(execFile)("powershell.exe", ["-NoProfile", "-Command", "(Get-CimInstance Win32_Processor | Measure-Object -Property NumberOfCores -Sum).Sum"], { windowsHide: true, timeout: 15_000 });
      n = Number(stdout.trim()) || undefined;
    }
  } catch {
    n = undefined;
  }
  physicalCache = n ?? (logical >= 4 ? Math.floor(logical / 2) : logical);
  return physicalCache;
}

/** Lowers a process to below-normal priority (Windows) / nice 10 (Linux, macOS); ignored when not allowed. */
function lowPriority(pid: number | undefined): void {
  if (!pid) return;
  try {
    setPriority(pid, osConstants.priority.PRIORITY_BELOW_NORMAL);
  } catch {
    /* not allowed: llama.cpp's own --prio -1 still lowers its threads */
  }
}

/** Waits until `ok()` is true (polls every half second) or the time is up. */
async function until(ok: () => Promise<boolean>, ms: number, failed?: () => string | undefined): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const why = failed?.();
    if (why) throw new Error(why);
    if (await ok().catch(() => false)) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`not ready after ${Math.round(ms / 1000)} s`);
}

/** llama.cpp's router mode: one process, a child per loaded role. */
class RouterBackend implements Backend {
  readonly kind = "router" as const;
  private proc?: ChildProcess;
  private port?: number;
  private readonly apiKey = randomBytes(24).toString("hex");
  /** The preset the running router read: role → its args as text, to see when it must be rewritten. */
  private started = new Map<CpuRole, string>();
  private readonly loaded = new Set<CpuRole>();
  private log: string[] = [];

  constructor(private readonly d: { binary: () => string | undefined; dir: string; entries: () => Promise<Array<{ role: CpuRole; spec: RoleSpec; threads: number; cpuRange?: string }>>; logLine: (l: string) => void }) {}

  private get base(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  private headers(): Record<string, string> {
    return { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` };
  }

  /** (Re)starts the router with a preset for every role whose model is on this computer. */
  private async start(): Promise<void> {
    const binary = this.d.binary();
    if (!binary) throw new Error("Install the engine first (Models → Chat).");
    await this.stopAll();
    const entries = await this.d.entries();
    const ini = join(this.d.dir, "cpu-pool", "models.ini");
    await mkdir(join(this.d.dir, "cpu-pool"), { recursive: true });
    await writeFile(ini, presetIni(entries), "utf8");
    this.port ??= await freePort();
    this.log = [];
    const proc = spawn(binary, ["--models-preset", ini, "--models-max", String(CPU_ROLES.length), "--no-models-autoload", "--host", "127.0.0.1", "--port", String(this.port)], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: { ...process.env, LLAMA_API_KEY: this.apiKey },
    });
    this.proc = proc;
    // Before any child starts (no autoload): they inherit it.
    lowPriority(proc.pid);
    const keep = (b: Buffer) => {
      this.log.push(...b.toString().split(/\r?\n/).filter(Boolean));
      if (this.log.length > 60) this.log.splice(0, this.log.length - 60);
    };
    proc.stdout?.on("data", keep);
    proc.stderr?.on("data", keep);
    proc.once("exit", () => {
      if (this.proc === proc) {
        this.proc = undefined;
        this.loaded.clear();
      }
    });
    await until(async () => (await fetch(`${this.base}/models`, { headers: this.headers() })).ok, 30_000, () => (proc.exitCode !== null ? `the CPU models' router stopped: ${this.log.slice(-3).join(" | ")}` : undefined));
    this.started = new Map(entries.map((e) => [e.role, presetIni([e])]));
  }

  async load(role: CpuRole, spec: RoleSpec, threads: number): Promise<void> {
    const want = (await this.d.entries()).find((e) => e.role === role) ?? { role, spec, threads };
    want.spec = spec;
    want.threads = threads;
    const differs = this.started.get(role) !== presetIni([want]);
    if (!this.proc || (differs && this.loaded.size === 0)) await this.start();
    else if (differs) {
      // Other models are loaded: the router reads its preset only at start, so this one keeps its old settings
      // (a new model file waits for the others to unload).
      if (!this.started.get(role)?.includes(`model = ${spec.file}\n`)) throw new Error(`The CPU models are busy; the new ${role} model loads when they are idle.`);
      this.d.logLine(`CPU pool: ${role} keeps its earlier threads until the other CPU models unload.`);
    }
    const res = await fetch(`${this.base}/models/load`, { method: "POST", headers: this.headers(), body: JSON.stringify({ model: role }) });
    if (!res.ok && !/already/i.test(await res.text())) throw new Error(`The CPU models' router refused to load ${role} (${res.status}).`);
    await until(async () => {
      const list = (await (await fetch(`${this.base}/models`, { headers: this.headers() })).json()) as { data?: Array<{ id: string; status?: { value?: string; failed?: boolean } }> };
      const m = list.data?.find((x) => x.id === role);
      if (m?.status?.failed) throw new Error(`the ${role} model failed to start`);
      return m?.status?.value === "loaded" || m?.status?.value === "sleeping";
    }, 180_000);
    this.loaded.add(role);
  }

  async unload(role: CpuRole): Promise<void> {
    this.loaded.delete(role);
    if (!this.proc) return;
    await fetch(`${this.base}/models/unload`, { method: "POST", headers: this.headers(), body: JSON.stringify({ model: role }) }).catch(() => undefined);
    // Nothing left: the router itself goes too.
    if (this.loaded.size === 0) await this.stopAll();
  }

  target(role: CpuRole): Target | undefined {
    return this.proc && this.loaded.has(role) ? { baseUrl: `${this.base}/v1`, apiKey: this.apiKey, model: role } : undefined;
  }

  async stopAll(): Promise<void> {
    const p = this.proc;
    this.proc = undefined;
    this.loaded.clear();
    this.started.clear();
    if (!p || p.exitCode !== null) return;
    p.kill();
    await new Promise((r) => {
      const t = setTimeout(() => (p.kill("SIGKILL"), r(undefined)), 5000);
      p.once("exit", () => (clearTimeout(t), r(undefined)));
    });
  }
}

/** One llama-server per role (builds without router mode). */
class InstancesBackend implements Backend {
  readonly kind = "instances" as const;
  private readonly engines = new Map<CpuRole, LlamaEngine>();

  constructor(private readonly d: { binary: () => string | undefined; dir: string; version?: string | undefined; cpuRange: () => string | undefined }) {}

  async load(role: CpuRole, spec: RoleSpec, threads: number): Promise<void> {
    const binaryPath = this.d.binary();
    if (!binaryPath) throw new Error("Install the engine first (Models → Chat).");
    await this.unload(role);
    const args = roleArgs(role, spec, threads, this.d.cpuRange()).flatMap(([k, v]) => (v === "true" ? [`--${k}`] : [`--${k}`, v]));
    // No host-RAM prompt cache for these small models (it would hold memory outside the pool's budget).
    const e = new LlamaEngine({ dir: this.d.dir, binaryPath, ...(this.d.version ? { version: this.d.version } : {}), port: await freePort(), args: [...args, "--cache-ram", "0"], parallel: 1 });
    this.engines.set(role, e);
    try {
      await e.load(spec.file, 180_000);
    } catch (err) {
      this.engines.delete(role);
      throw err;
    }
    lowPriority(e.pid);
  }

  async unload(role: CpuRole): Promise<void> {
    const e = this.engines.get(role);
    this.engines.delete(role);
    await e?.stop("CPU pool: unloaded");
  }

  target(role: CpuRole): Target | undefined {
    const e = this.engines.get(role);
    return e?.status().running ? { baseUrl: e.baseUrl, apiKey: e.apiKey, model: role } : undefined;
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.engines.keys()].map((r) => this.unload(r)));
  }
}

/** The pool with its engine, and the calls the watchdog, the translator and embeddings make. */
export interface CpuModels {
  pool: CpuPool;
  /** Which engine runs the models now. */
  kind(): "router" | "instances";
  /** Whether the pool is on (Settings). */
  enabled(): boolean;
  /** A chat completion on a role's model through the pool's queue; the answer text. */
  complete(role: CpuRole, messages: CpuMessage[], o: { maxTokens?: number; temperature?: number }, signal?: AbortSignal): Promise<string>;
  /** Embeddings through the pool's queue. */
  embed(input: string[], signal?: AbortSignal): Promise<number[][]>;
  /** The translator's model file the next translation loads (set by the translator). */
  useTranslator(file: string): void;
  /** Whether the translator should run on the processor now (the setting, and for "auto" a game or the main model). */
  translatorOnCpu(mainLoaded: boolean): Promise<boolean>;
  /** The X3D plain-CCD range when this processor has one. */
  pinnable(): string | undefined;
  stop(): Promise<void>;
}

/**
 * Builds the pool.
 *
 * @param p.config - The settings (`cpuPool`, `guard` idle minutes, the engine's version).
 * @param p.enginesDir - The engines folder (the router's preset goes in `cpu-pool/`).
 * @param p.binary - The main engine's llama-server (undefined until installed).
 * @param p.files - Each role's GGUF file, when it is on this computer.
 * @param p.games - Which games run (background roles wait meanwhile).
 * @param p.log - Logs a line.
 */
export async function buildCpuModels(p: {
  config: KesherConfig;
  enginesDir: string;
  binary: () => string | undefined;
  files: { [R in CpuRole]?: () => string | undefined | Promise<string | undefined> };
  games: Pick<GameWatch, "running">;
  log: (line: string) => void;
}): Promise<CpuModels> {
  const cfg = () => p.config.cpuPool;
  const physical = await physicalCores();
  const model = cpus()[0]?.model ?? "";
  const plain = plainCcdRange(model, physical, cpus().length);
  const cpuRange = () => (cfg().pinCcd && plain ? plain : undefined);
  let translatorFile: string | undefined;
  const spec = async (role: CpuRole): Promise<RoleSpec | undefined> => {
    const file = role === "translator" ? (translatorFile ?? (await p.files.translator?.())) : await p.files[role]?.();
    if (!file || !existsSync(file)) return undefined;
    // The file is mapped into memory whole, plus its context and buffers (measured on the PC: a 2B Q4 at 4K ≈ +300 MB).
    const mb = statSync(file).size / 1024 ** 2;
    return { file, ramMb: Math.round(mb * 1.1 + (CTX[role] >= 8192 ? 500 : 300)), ...(role === "embeddings" ? { embeddings: true } : {}) };
  };
  const settings = (): PoolSettings => ({
    maxGenerating: cfg().maxGenerating,
    ramBudgetMb: cfg().ramBudgetMb || Math.round(totalmem() / 1024 ** 2 / 4),
    idleMinutes: { chat: cfg().idleChat, watchdog: cfg().idleWatchdog, translator: p.config.guard.idleTranslator ?? 5, embeddings: p.config.guard.idleEmbeddings ?? 5 },
  });
  // Pinned to the plain CCD: the budget is that CCD's cores (the game keeps the cache CCD).
  const cores = () => (cpuRange() ? Math.floor(physical / 2) + 1 : physical);
  // The router's preset needs the pool's thread counts, and the pool needs the router: made just below.
  const ref: { pool?: CpuPool } = {};
  const entries = async () => {
    const out: Array<{ role: CpuRole; spec: RoleSpec; threads: number; cpuRange?: string }> = [];
    for (const role of CPU_ROLES) {
      const s = await spec(role);
      const range = cpuRange();
      if (s) out.push({ role, spec: s, threads: ref.pool!.threadsFor(role), ...(range ? { cpuRange: range } : {}) });
    }
    return out;
  };
  const router = new RouterBackend({ binary: p.binary, dir: p.enginesDir, entries, logLine: p.log });
  const instances = new InstancesBackend({ binary: p.binary, dir: p.enginesDir, version: p.config.engines.llamaVersion, cpuRange });
  let backend: Backend = hasRouterMode(p.config.engines.llamaVersion) ? router : instances;
  const engine: PoolEngine = {
    load: async (role, s, threads) => {
      try {
        await backend.load(role, s, threads);
      } catch (e) {
        // The router did not start (an unexpected build): one server per role from now on.
        if (backend !== router || /busy/.test(String(e))) throw e;
        p.log(`CPU pool: router mode did not start (${e instanceof Error ? e.message : String(e)}); one llama-server per model instead.`);
        await router.stopAll();
        backend = instances;
        await backend.load(role, s, threads);
      }
    },
    unload: (role) => backend.unload(role),
  };
  const pool = (ref.pool = new CpuPool({ engine, spec, settings, get cores() { return cores(); }, log: p.log }));
  // The game watch only while something is loaded or waiting (it lists the running programs every 30 seconds).
  const poll = setInterval(() => {
    if (!pool.active) return void pool.setPlaying(false);
    void p.games.running().then((g) => pool.setPlaying(g.length > 0), () => undefined);
  }, 30_000);
  poll.unref?.();
  const call = async <T>(role: CpuRole, path: string, body: Record<string, unknown>, signal: AbortSignal | undefined, read: (json: unknown, report: (n: number) => void) => T): Promise<T> =>
    pool.run(role, async (ctx) => {
      const t = backend.target(role);
      if (!t) throw new Error(`The ${role} model is not loaded.`);
      const res = await fetch(`${t.baseUrl}${path}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${t.apiKey}` }, body: JSON.stringify({ model: t.model, ...body }), ...(signal ? { signal } : {}) });
      if (!res.ok) throw new Error(`The ${role} model answered ${res.status}`);
      return read(await res.json(), ctx.report);
    }, signal);
  return {
    pool,
    kind: () => backend.kind,
    enabled: () => cfg().enabled,
    complete: (role, messages, o, signal) =>
      call(role, "/chat/completions", { messages, temperature: o.temperature ?? 0.2, ...(o.maxTokens ? { max_tokens: o.maxTokens } : {}), chat_template_kwargs: { enable_thinking: false } }, signal, (json, report) => {
        const j = json as { choices?: Array<{ message?: { content?: string } }>; usage?: { completion_tokens?: number } };
        if (j.usage?.completion_tokens) report(j.usage.completion_tokens);
        return j.choices?.[0]?.message?.content ?? "";
      }),
    embed: (input, signal) =>
      call("embeddings", "/embeddings", { input }, signal, (json, report) => {
        const j = json as { data?: Array<{ index?: number; embedding: number[] }>; usage?: { prompt_tokens?: number } };
        if (j.usage?.prompt_tokens) report(j.usage.prompt_tokens);
        const data = [...(j.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
        if (data.length !== input.length) throw new Error(`The embedding model returned ${data.length} vectors for ${input.length} texts.`);
        return data.map((d) => d.embedding);
      }),
    useTranslator: (file) => void (translatorFile = file),
    translatorOnCpu: async (mainLoaded) => {
      const device = cfg().enabled ? cfg().translatorDevice : "gpu";
      if (device !== "auto") return device === "cpu";
      return mainLoaded || (await p.games.running().catch(() => [])).length > 0;
    },
    pinnable: () => plain,
    stop: async () => {
      clearInterval(poll);
      await pool.stop();
      await backend.stopAll();
    },
  };
}

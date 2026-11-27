/**
 * The pool of small dedicated models on the processor (Roee, 27.11; docs/research/r-20261127-04.md): the watchdog, the
 * translator, embeddings and (later) the hub's task chat share one CPU budget instead of each starting its own
 * llama.cpp when it likes.
 *
 * This file is the scheduler only; the engine comes in as a {@link PoolEngine} (server/build-cpu-pool.ts gives
 * llama.cpp's router mode or one instance per role; tests give a fake). What it decides:
 * - at most `maxGenerating` jobs at once; the rest wait in a queue ordered by role (chat > watchdog > translator >
 *   embeddings), first come first served inside a role;
 * - threads: the physical cores less two, split among the jobs that may run at once, fixed when a model loads;
 * - while a game runs, background roles wait and the interactive one loads with half the threads;
 * - a RAM budget: a model that does not fit waits until idle ones are unloaded (lowest role first), and is refused when
 *   it can never fit;
 * - each role is unloaded after its own idle minutes (0 keeps it loaded).
 */
import { basename } from "node:path";

/** The jobs the pool runs, highest priority first. */
export const CPU_ROLES = ["chat", "watchdog", "translator", "embeddings"] as const;
/** One of {@link CPU_ROLES}. */
export type CpuRole = (typeof CPU_ROLES)[number];

/** Roles the user waits on; all others are background work and wait while a game runs. */
const INTERACTIVE = new Set<CpuRole>(["chat"]);

/** What a role loads. */
export interface RoleSpec {
  /** The GGUF file. */
  file: string;
  /** Memory it takes while loaded (MB): the file plus its context. */
  ramMb: number;
  /** An embedding model (the engine starts it with `--embedding`). */
  embeddings?: boolean;
}

/** What the pool needs from the engine that runs the models. */
export interface PoolEngine {
  /** Loads a role's model with this many threads (never on the graphics card). */
  load(role: CpuRole, spec: RoleSpec, threads: number): Promise<void>;
  /** Unloads it (frees its memory). */
  unload(role: CpuRole): Promise<void>;
}

/** The pool's settings (config `cpuPool`). */
export interface PoolSettings {
  /** Jobs generating at the same time (1–4). */
  maxGenerating: number;
  /** The memory all loaded models may take together (MB). */
  ramBudgetMb: number;
  /** Idle minutes per role before its model is unloaded (0 keeps it loaded). */
  idleMinutes: Record<CpuRole, number>;
}

/** Given to a job: reports how many tokens it made, for the tokens-per-second figure. */
export interface JobContext {
  report(tokens: number): void;
}

/** The pieces of {@link CpuPool}. */
export interface CpuPoolDeps {
  engine: PoolEngine;
  /** What a role loads, or undefined when its model is not on this computer. */
  spec: (role: CpuRole) => RoleSpec | undefined | Promise<RoleSpec | undefined>;
  settings: () => PoolSettings;
  /** The processor's physical cores. */
  cores: number;
  now?: () => number;
  /** Timer functions (tests pass fakes). */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
  log?: (line: string) => void;
}

/** One role as the PC Health card shows it. */
export interface RoleStatus {
  role: CpuRole;
  /** The model file's name (no folder), when known. */
  model?: string;
  state: "unloaded" | "loading" | "loaded" | "running";
  threads?: number;
  ramMb?: number;
  /** Tokens a second of its last job, when it reported tokens. */
  tps?: number;
  /** Jobs waiting for it. */
  queued: number;
}

/** The whole pool as the PC Health card shows it. */
export interface PoolStatus {
  roles: RoleStatus[];
  running: number;
  maxGenerating: number;
  ramUsedMb: number;
  ramBudgetMb: number;
  threadsBudget: number;
  /** A game runs: background roles wait. */
  playing: boolean;
}

interface Loaded {
  spec: RoleSpec;
  threads: number;
  ready: Promise<void>;
  loading: boolean;
  busy: number;
  lastUsed: number;
  timer?: unknown;
}

interface Waiting {
  role: CpuRole;
  spec: RoleSpec;
  seq: number;
  start: () => void;
  fail: (e: Error) => void;
}

/** The scheduler; see the file's comment. */
export class CpuPool {
  private readonly loaded = new Map<CpuRole, Loaded>();
  private queue: Waiting[] = [];
  private running = 0;
  private seq = 0;
  private playing = false;
  private readonly tps = new Map<CpuRole, number>();
  private readonly known = new Map<CpuRole, RoleSpec>();

  /** @param d - The engine, the model per role, the settings, the cores and the clock. */
  constructor(private readonly d: CpuPoolDeps) {}

  /** Threads all jobs share: the physical cores less two (for the system and the game), at least one. */
  get threadsBudget(): number {
    return Math.max(1, Math.floor(this.d.cores) - 2);
  }

  /**
   * The threads a role's model loads with now.
   *
   * @param role - The role.
   */
  threadsFor(role: CpuRole): number {
    const each = Math.max(1, Math.floor(this.threadsBudget / Math.max(1, this.max())));
    return this.playing && INTERACTIVE.has(role) ? Math.max(1, Math.floor(each / 2)) : each;
  }

  /** Whether anything is loaded or waiting (the caller polls the game watch only then). */
  get active(): boolean {
    return this.loaded.size > 0 || this.queue.length > 0;
  }

  /**
   * A game started or ended. Started: background jobs wait, idle models whose threads no longer fit are unloaded
   * (they load again with the new count). Ended: the waiting jobs go on.
   *
   * @param on - Whether a game runs now.
   */
  setPlaying(on: boolean): void {
    if (on === this.playing) return;
    this.playing = on;
    for (const [role, l] of this.loaded) if (!l.busy && !l.loading && l.threads !== this.threadsFor(role)) void this.release(role, on ? "a game started" : "the game ended");
    this.pump();
  }

  /**
   * Runs one job on a role's model: waits for its turn, loads the model when needed, then calls `job`.
   *
   * @param role - Which model.
   * @param job - The work (talks to the engine itself); it may report its tokens.
   * @param signal - Aborts while it still waits.
   * @returns The job's result.
   */
  async run<T>(role: CpuRole, job: (ctx: JobContext) => Promise<T>, signal?: AbortSignal): Promise<T> {
    const spec = await this.d.spec(role);
    if (!spec) throw new Error(`No ${role} model on this computer.`);
    this.known.set(role, spec);
    if (spec.ramMb > this.d.settings().ramBudgetMb) throw new Error(`The ${role} model needs ${Math.round(spec.ramMb)} MB, more than the CPU models' memory budget (${this.d.settings().ramBudgetMb} MB).`);
    signal?.throwIfAborted();
    await new Promise<void>((start, fail) => {
      const w: Waiting = { role, spec, seq: this.seq++, start, fail };
      this.queue.push(w);
      signal?.addEventListener("abort", () => {
        const i = this.queue.indexOf(w);
        if (i >= 0) {
          this.queue.splice(i, 1);
          fail(new Error("Cancelled while waiting for the CPU."));
        }
      }, { once: true });
      this.pump();
    });
    // pump() counted the job as running and made (or found) the loaded entry.
    const l = this.loaded.get(role)!;
    const now = this.d.now ?? Date.now;
    let tokens = 0;
    try {
      await l.ready;
      const t0 = now();
      const out = await job({ report: (n) => void (tokens += n) });
      const secs = (now() - t0) / 1000;
      if (tokens > 0 && secs > 0) this.tps.set(role, Math.round((tokens / secs) * 10) / 10);
      return out;
    } finally {
      this.running--;
      l.busy--;
      l.lastUsed = now();
      if (this.loaded.get(role) === l) this.scheduleIdle(role, l);
      this.pump();
    }
  }

  /** The jobs allowed at once. */
  private max(): number {
    return Math.min(4, Math.max(1, Math.round(this.d.settings().maxGenerating)));
  }

  /** Memory the loaded models take (MB). */
  private ramUsed(): number {
    let mb = 0;
    for (const l of this.loaded.values()) mb += l.spec.ramMb;
    return mb;
  }

  /** Starts every waiting job that may start now, in priority order. */
  private pump(): void {
    const rank = (r: CpuRole) => CPU_ROLES.indexOf(r);
    this.queue.sort((a, b) => rank(a.role) - rank(b.role) || a.seq - b.seq);
    for (const w of [...this.queue]) {
      if (this.running >= this.max()) break;
      if (this.playing && !INTERACTIVE.has(w.role)) continue;
      let l = this.loaded.get(w.role);
      // The role's model changed (another translator file): the old one goes once it is idle.
      if (l && l.spec.file !== w.spec.file) {
        if (l.busy || l.loading) continue;
        void this.release(w.role, "its model changed");
        l = undefined;
      }
      if (!l && !this.makeRoom(w.role, w.spec.ramMb)) continue;
      if (!l) l = this.startLoad(w.role, w.spec);
      this.queue.splice(this.queue.indexOf(w), 1);
      this.cancelIdle(l);
      l.busy++;
      this.running++;
      w.start();
    }
  }

  /**
   * Frees memory for a model: unloads idle models, the lowest role first, then the least recently used.
   *
   * @returns Whether it fits now.
   */
  private makeRoom(role: CpuRole, needMb: number): boolean {
    const budget = this.d.settings().ramBudgetMb;
    if (this.ramUsed() + needMb <= budget) return true;
    const idle = [...this.loaded].filter(([r, l]) => r !== role && !l.busy && !l.loading);
    // Only unload when that is enough; otherwise everything stays and the job waits.
    const freeable = idle.reduce((mb, [, l]) => mb + l.spec.ramMb, 0);
    if (this.ramUsed() - freeable + needMb > budget) return false;
    idle.sort(([a, x], [b, y]) => CPU_ROLES.indexOf(b) - CPU_ROLES.indexOf(a) || x.lastUsed - y.lastUsed);
    for (const [r] of idle) {
      if (this.ramUsed() + needMb <= budget) break;
      void this.release(r, `memory for the ${role} model`);
    }
    return true;
  }

  /** Starts loading a role's model and records it as loaded (its memory counts from now). */
  private startLoad(role: CpuRole, spec: RoleSpec): Loaded {
    const threads = this.threadsFor(role);
    const l: Loaded = { spec, threads, loading: true, busy: 0, lastUsed: (this.d.now ?? Date.now)(), ready: Promise.resolve() };
    l.ready = this.d.engine.load(role, spec, threads).then(
      () => void (l.loading = false),
      (e: unknown) => {
        if (this.loaded.get(role) === l) this.loaded.delete(role);
        this.d.log?.(`CPU pool: the ${role} model did not load: ${e instanceof Error ? e.message : String(e)}`);
        throw e;
      },
    );
    this.loaded.set(role, l);
    return l;
  }

  private scheduleIdle(role: CpuRole, l: Loaded): void {
    this.cancelIdle(l);
    if (l.busy) return;
    const min = this.d.settings().idleMinutes[role];
    if (!(min > 0)) return;
    const set = this.d.setTimer ?? ((fn: () => void, ms: number) => {
      const h = setTimeout(fn, ms);
      h.unref?.();
      return h;
    });
    l.timer = set(() => {
      l.timer = undefined;
      if (this.loaded.get(role) === l && !l.busy) void this.release(role, `idle ${min} min`);
    }, min * 60_000);
  }

  private cancelIdle(l: Loaded): void {
    if (l.timer !== undefined) (this.d.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>)))(l.timer);
    l.timer = undefined;
  }

  /** Unloads a role's model (it must not be busy); the memory counts as free at once. */
  private async release(role: CpuRole, why: string): Promise<void> {
    const l = this.loaded.get(role);
    if (!l) return;
    this.cancelIdle(l);
    this.loaded.delete(role);
    this.d.log?.(`CPU pool: ${role} unloaded (${why}).`);
    await l.ready.catch(() => undefined);
    await this.d.engine.unload(role).catch(() => undefined);
    this.pump();
  }

  /**
   * Unloads a role's model now when it is idle (Free memory, a setting changed).
   *
   * @param role - The role.
   * @returns Whether it was unloaded.
   */
  async unload(role: CpuRole): Promise<boolean> {
    const l = this.loaded.get(role);
    if (!l || l.busy) return false;
    await this.release(role, "asked");
    return true;
  }

  /** Unloads every idle model and refuses the waiting jobs (the app closes). */
  async stop(): Promise<void> {
    for (const w of this.queue.splice(0)) w.fail(new Error("The CPU models stopped."));
    await Promise.all([...this.loaded.keys()].map((r) => this.unload(r)));
  }

  /** @returns What the PC Health card shows. */
  status(): PoolStatus {
    const roles = CPU_ROLES.map((role): RoleStatus => {
      const l = this.loaded.get(role);
      const spec = l?.spec ?? this.known.get(role);
      const tps = this.tps.get(role);
      return {
        role,
        ...(spec ? { model: basename(spec.file.replace(/\\/g, "/")) } : {}),
        state: !l ? "unloaded" : l.loading ? "loading" : l.busy ? "running" : "loaded",
        ...(l ? { threads: l.threads, ramMb: Math.round(l.spec.ramMb) } : {}),
        ...(tps !== undefined ? { tps } : {}),
        queued: this.queue.filter((w) => w.role === role).length,
      };
    });
    return { roles, running: this.running, maxGenerating: this.max(), ramUsedMb: Math.round(this.ramUsed()), ramBudgetMb: this.d.settings().ramBudgetMb, threadsBudget: this.threadsBudget, playing: this.playing };
  }

  /**
   * Remembers which model a role would load, so the card can name it before its first job.
   *
   * @param role - The role.
   */
  async describe(role: CpuRole): Promise<void> {
    const spec = await Promise.resolve(this.d.spec(role)).catch(() => undefined);
    if (spec) this.known.set(role, spec);
    else this.known.delete(role);
  }
}

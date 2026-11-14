import { execFile } from "node:child_process";
import { cpus, freemem, setPriority, constants, totalmem } from "node:os";
import { readFile } from "node:fs/promises";

/**
 * Keeps the graphics card safe and the computer pleasant to use while local
 * models run ("don't wreck the graphics card").
 *
 * - **Watches** every NVIDIA card (temperature, load, memory, power) with
 *   `nvidia-smi`: often while something runs, rarely when idle.
 * - **Cools down:** when a card reaches the user's limit, new work waits
 *   (what already runs finishes) until it is back under the resume
 *   temperature.
 * - **Pause / resume:** the user can hold all new local work, and let it go.
 * - **Frees memory:** a model nobody used for a while is unloaded; it loads
 *   again by itself on the next request.
 * - **Gentle mode:** the model engines run at low priority, so the rest of
 *   the computer (games, editing, calls) comes first.
 *
 * Work is held at one place: every local provider's chat, image and video
 * calls go through {@link GpuGuard.before} (see `ProviderRegistry.setGate`).
 */

/** One card's reading. */
export interface GpuReading {
  index: number;
  name: string;
  /** °C. */
  temp: number;
  /** Percent. */
  util: number;
  /** Bytes. */
  memUsed: number;
  memTotal: number;
  /** Watts; undefined when the card does not report it. */
  power?: number;
  powerLimit?: number;
}

/** The guard's settings (config `guard`). */
export interface GuardConfig {
  enabled: boolean;
  /** New work waits at this temperature (°C). */
  maxTemp: number;
  /** …and goes on once every card is back under this. */
  resumeTemp: number;
  /** Unload a model unused for this long (minutes); 0 = keep it loaded. */
  unloadAfterMinutes: number;
  /** Run the engines at low priority. */
  gentle: boolean;
  /** New local work waits while the computer's memory (RAM) use is at or above this percent; 0 = no limit. Idle models are unloaded to free it. */
  maxRamPercent: number;
  /** New local work waits while the processor is this busy (percent, averaged over a few readings); 0 = no limit. */
  maxCpuPercent: number;
  /** New local work waits while the processor is this hot (°C); 0 = no limit. Goes on 7 °C lower. */
  maxCpuTemp: number;
}

/** The computer's own readings (memory, processor, processor temperature). */
export interface SystemReading {
  ramUsed: number;
  ramTotal: number;
  /** Percent, averaged over the last readings. */
  cpu: number;
  /** °C, when the system tells it (Windows thermal zones, Linux /sys); undefined otherwise. */
  cpuTemp?: number;
}

/** Reads the processor's temperature; replaceable in tests. */
export type CpuTempReader = () => Promise<number | undefined>;

/**
 * The processor's temperature without administrator rights: Windows' thermal
 * zone counters (tenths of Kelvin), Linux's /sys thermal zones. Many desktops
 * do not report it; then it is undefined and the limit is not used.
 */
export const realCpuTemp: CpuTempReader = async () => {
  if (process.platform === "win32") {
    const out = await new Promise<string>((resolve) =>
      execFile(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", "(Get-CimInstance Win32_PerfFormattedData_Counters_ThermalZoneInformation -ErrorAction SilentlyContinue | Measure-Object -Property HighPrecisionTemperature -Maximum).Maximum"],
        { timeout: 8000, windowsHide: true },
        (err, o) => resolve(err ? "" : o),
      ),
    );
    const tenthsK = Number(out.trim());
    if (!Number.isFinite(tenthsK) || tenthsK <= 0) return undefined;
    const c = tenthsK / 10 - 273.15;
    return c > 5 && c < 130 ? Math.round(c) : undefined;
  }
  if (process.platform === "linux") {
    let best: number | undefined;
    for (let i = 0; i < 12; i++) {
      const v = Number((await readFile(`/sys/class/thermal/thermal_zone${i}/temp`, "utf8").catch(() => "")).trim());
      if (Number.isFinite(v) && v > 0) best = Math.max(best ?? 0, Math.round(v / 1000));
    }
    return best;
  }
  return undefined;
};

/**
 * Why new work should wait because of the computer itself (not the graphics card), or nothing.
 * Hysteresis: once holding, memory goes on 5 points lower, the processor 15 points lower, its temperature 7 °C lower.
 *
 * @param r - The readings.
 * @param cfg - The limits.
 * @param was - The previous reason.
 * @returns The reason in words, or undefined.
 */
export function systemHold(r: SystemReading, cfg: Pick<GuardConfig, "maxRamPercent" | "maxCpuPercent" | "maxCpuTemp">, was?: string): string | undefined {
  const ram = r.ramTotal ? (r.ramUsed / r.ramTotal) * 100 : 0;
  const slack = (n: number) => (was ? n : 0);
  if (cfg.maxRamPercent > 0 && ram >= cfg.maxRamPercent - slack(5)) return `memory (RAM) is ${Math.round(ram)}% used (limit ${cfg.maxRamPercent}%)`;
  if (cfg.maxCpuPercent > 0 && r.cpu >= cfg.maxCpuPercent - slack(15)) return `the processor is ${Math.round(r.cpu)}% busy (limit ${cfg.maxCpuPercent}%)`;
  if (cfg.maxCpuTemp > 0 && r.cpuTemp !== undefined && r.cpuTemp >= cfg.maxCpuTemp - slack(7)) return `the processor is ${r.cpuTemp} °C (limit ${cfg.maxCpuTemp} °C)`;
  return undefined;
}

/** The defaults: safe for every NVIDIA card (they slow themselves down near 90 °C). */
export const GUARD_DEFAULTS: GuardConfig = { enabled: true, maxTemp: 83, resumeTemp: 75, unloadAfterMinutes: 20, gentle: false, maxRamPercent: 0, maxCpuPercent: 0, maxCpuTemp: 0 };

/** What Settings and the status bar show. */
export interface GuardStatus {
  config: GuardConfig;
  cards: GpuReading[];
  /** The user paused new work. */
  paused: boolean;
  /** A card is too hot; new work waits. */
  cooling: boolean;
  /** The computer's memory, processor and processor temperature. */
  system: SystemReading;
  /** Why new work waits because of the computer itself (memory, processor), if it does. */
  systemHold?: string;
  /** Requests waiting right now. */
  waiting: number;
  /** Requests running right now. */
  running: number;
  /** When the last local request ended (ISO), for "unloads in …". */
  lastActive?: string;
  /** What was unloaded last, and when. */
  lastUnload?: { what: string; at: string };
}

const num = (s: string | undefined) => {
  const n = Number((s ?? "").trim());
  return Number.isFinite(n) ? n : undefined;
};

/**
 * Parses `nvidia-smi --query-gpu=index,name,temperature.gpu,utilization.gpu,memory.used,memory.total,power.draw,power.limit --format=csv,noheader,nounits`.
 *
 * @param out - Its output.
 * @returns One reading per card (cards that report "[N/A]" for power get none).
 */
export function parseSmi(out: string): GpuReading[] {
  const cards: GpuReading[] = [];
  for (const line of out.split(/\r?\n/)) {
    const f = line.split(",").map((x) => x.trim());
    if (f.length < 6) continue;
    const index = num(f[0]);
    const temp = num(f[2]);
    if (index === undefined || temp === undefined) continue;
    const power = num(f[6]);
    const powerLimit = num(f[7]);
    cards.push({
      index,
      name: f[1]!,
      temp,
      util: num(f[3]) ?? 0,
      memUsed: (num(f[4]) ?? 0) * 1024 ** 2,
      memTotal: (num(f[5]) ?? 0) * 1024 ** 2,
      ...(power !== undefined ? { power } : {}),
      ...(powerLimit !== undefined ? { powerLimit } : {}),
    });
  }
  return cards;
}

/**
 * Whether new work should wait for the cards to cool, with hysteresis: it
 * starts waiting at `maxTemp` and goes on only under `resumeTemp`.
 *
 * @param cards - Current readings.
 * @param cfg - Limits.
 * @param wasCooling - The previous answer.
 * @returns The new answer.
 */
export function shouldCool(cards: readonly GpuReading[], cfg: Pick<GuardConfig, "maxTemp" | "resumeTemp">, wasCooling: boolean): boolean {
  if (!cards.length) return false;
  const hottest = Math.max(...cards.map((c) => c.temp));
  return wasCooling ? hottest >= cfg.resumeTemp : hottest >= cfg.maxTemp;
}

/** Something the guard can unload when idle, and load again on demand. */
export interface Unloadable {
  /** Shown to the user, e.g. "chat model". */
  name: string;
  /** Provider ids that need it (their calls load it again). */
  providers: string[];
  loaded(): boolean;
  unload(): Promise<void>;
  /** Loads it again before a request; undefined when it cannot come back by itself. */
  reload?(): Promise<void>;
  /** Called when one of its providers starts work (for engines that track use themselves). */
  used?(): void;
  /** Process ids to lower in gentle mode. */
  pids(): number[];
}

/** Reads the cards; replaceable in tests. */
export type SmiReader = () => Promise<string>;

const realSmi: SmiReader = () =>
  new Promise((resolve, reject) =>
    execFile(
      "nvidia-smi",
      ["--query-gpu=index,name,temperature.gpu,utilization.gpu,memory.used,memory.total,power.draw,power.limit", "--format=csv,noheader,nounits"],
      { timeout: 5000, windowsHide: true },
      (err, out) => (err ? reject(err) : resolve(out)),
    ),
  );

/** The guard. One per server. */
export class GpuGuard {
  private cards: GpuReading[] = [];
  private paused = false;
  private cooling = false;
  private sys: SystemReading = { ramUsed: 0, ramTotal: totalmem(), cpu: 0 };
  private sysHold?: string;
  private cpuSamples: number[] = [];
  private lastCpu?: { idle: number; total: number };
  private lastTempAt = 0;
  private waiting = 0;
  private running = 0;
  private lastActive = Date.now();
  private lastUnload?: GuardStatus["lastUnload"];
  private timer?: NodeJS.Timeout;
  private smiWorks = true;
  private readonly wakers = new Set<() => void>();
  private readonly items: Unloadable[] = [];

  /**
   * @param config - The `guard` config section (read live, so changes apply at once).
   * @param smi - Reads the cards (tests pass a fake).
   * @param notify - Tells the user something happened (cooling started, model unloaded).
   */
  constructor(
    private readonly config: () => GuardConfig,
    private readonly smi: SmiReader = realSmi,
    private readonly notify: (text: string) => void = () => undefined,
    private readonly cpuTemp: CpuTempReader = realCpuTemp,
    private readonly memory: () => { used: number; total: number } = () => ({ used: totalmem() - freemem(), total: totalmem() }),
  ) {}

  /** Memory and processor now (the processor averaged over the last 4 readings). */
  private async readSystem(cfg: GuardConfig): Promise<void> {
    const mem = this.memory();
    let idle = 0;
    let total = 0;
    for (const c of cpus()) {
      idle += c.times.idle;
      total += c.times.user + c.times.nice + c.times.sys + c.times.idle + c.times.irq;
    }
    if (this.lastCpu && total > this.lastCpu.total) {
      const busy = 100 - ((idle - this.lastCpu.idle) / (total - this.lastCpu.total)) * 100;
      this.cpuSamples = [...this.cpuSamples.slice(-3), Math.max(0, Math.min(100, busy))];
    }
    this.lastCpu = { idle, total };
    const cpu = this.cpuSamples.length ? this.cpuSamples.reduce((a, b) => a + b, 0) / this.cpuSamples.length : 0;
    // The temperature costs a process start on Windows: read it only when its limit is on, at most every 15 s.
    let cpuTemp = this.sys.cpuTemp;
    if (cfg.maxCpuTemp > 0 && Date.now() - this.lastTempAt > 15_000) {
      this.lastTempAt = Date.now();
      cpuTemp = await this.cpuTemp().catch(() => undefined);
    }
    this.sys = { ramUsed: mem.used, ramTotal: mem.total, cpu: Math.round(cpu), ...(cpuTemp !== undefined ? { cpuTemp } : {}) };
  }

  /**
   * Adds an engine the guard may unload when idle.
   *
   * @param item - The engine.
   */
  add(item: Unloadable): void {
    this.items.push(item);
  }

  /** Starts watching. */
  start(): void {
    const tick = async () => {
      await this.check().catch(() => undefined);
      const busy = this.running > 0 || this.waiting > 0 || this.cooling || !!this.sysHold;
      this.timer = setTimeout(() => void tick(), busy ? 3000 : 15_000);
      this.timer.unref?.();
    };
    void tick();
  }

  /** Stops watching. */
  stop(): void {
    clearTimeout(this.timer);
  }

  /** One round: read the cards, cool down or go on, unload idle engines, lower priorities. */
  async check(): Promise<void> {
    const cfg = this.config();
    if (this.smiWorks) {
      try {
        this.cards = parseSmi(await this.smi());
      } catch {
        // No NVIDIA card or driver: nothing to watch (pause and unloading still work).
        this.smiWorks = false;
        this.cards = [];
      }
    }
    const was = this.cooling;
    this.cooling = cfg.enabled && shouldCool(this.cards, cfg, was);
    if (this.cooling && !was) {
      const hot = this.cards.reduce((a, b) => (b.temp > a.temp ? b : a));
      this.notify(`${hot.name} reached ${hot.temp} °C — new work waits until it cools to ${cfg.resumeTemp} °C.`);
    }
    if (!this.cooling && was) this.release();

    // The computer itself: memory, processor, processor temperature.
    await this.readSystem(cfg).catch(() => undefined);
    const hadSys = this.sysHold;
    this.sysHold = cfg.enabled ? systemHold(this.sys, cfg, hadSys) : undefined;
    if (this.sysHold && !hadSys) {
      this.notify(`New local work waits: ${this.sysHold}.`);
      // Short of memory: free what nobody is using.
      if (/memory/.test(this.sysHold) && this.running === 0) await this.freeNow();
    }
    if (!this.sysHold && hadSys) this.release();

    if (cfg.enabled && cfg.unloadAfterMinutes > 0 && this.running === 0 && this.waiting === 0 && Date.now() - this.lastActive > cfg.unloadAfterMinutes * 60_000) {
      await this.freeNow();
    }

    if (cfg.gentle) {
      for (const pid of this.items.flatMap((i) => i.pids())) {
        try {
          setPriority(pid, constants.priority.PRIORITY_BELOW_NORMAL);
        } catch {
          // the process just ended
        }
      }
    }
  }

  /** The processes of the models KesherAI runs now (the engine, ComfyUI…): never closed as left over. */
  ownPids(): number[] {
    return this.items.flatMap((i) => i.pids());
  }

  /** Unloads every loaded engine now (while nothing runs), to free the cards' memory. */
  async freeNow(): Promise<void> {
    for (const item of this.items) {
      if (!item.loaded()) continue;
      await item.unload().catch(() => undefined);
      this.lastUnload = { what: item.name, at: new Date().toISOString() };
    }
  }

  private release(): void {
    for (const w of [...this.wakers]) w();
  }

  private get holding(): boolean {
    return this.paused || this.cooling || !!this.sysHold;
  }

  /**
   * Holds or lets go of all new local work.
   *
   * @param on - True to pause.
   */
  setPaused(on: boolean): void {
    this.paused = on;
    if (!on) this.release();
  }

  /**
   * Marks activity that does not go through a provider (ComfyUI's own editor).
   *
   * @param providerId - Whose engine was used.
   */
  touch(providerId?: string): void {
    this.lastActive = Date.now();
    if (providerId) for (const item of this.items) if (item.providers.includes(providerId)) item.used?.();
  }

  /**
   * Waits until local work may start, and loads an unloaded engine again.
   * Call {@link after} when the work ends.
   *
   * @param providerId - The provider about to run.
   * @param signal - Cancels the wait.
   */
  async before(providerId: string, signal?: AbortSignal): Promise<void> {
    this.waiting++;
    try {
      while (this.config().enabled && this.holding) {
        if (signal?.aborted) throw new Error("Cancelled while waiting for the graphics card.");
        await new Promise<void>((resolve) => {
          const done = () => {
            this.wakers.delete(done);
            signal?.removeEventListener("abort", done);
            clearTimeout(t);
            resolve();
          };
          const t = setTimeout(done, 5000);
          this.wakers.add(done);
          signal?.addEventListener("abort", done, { once: true });
        });
        // A paused guard with the switch turned off lets everything through.
        if (!this.config().enabled) this.paused = false;
      }
    } finally {
      this.waiting--;
    }
    this.running++;
    this.lastActive = Date.now();
    try {
      for (const item of this.items) {
        if (!item.providers.includes(providerId)) continue;
        if (!item.loaded() && item.reload) await item.reload();
        item.used?.();
      }
    } catch (err) {
      this.after();
      throw err;
    }
  }

  /** Ends what {@link before} started. */
  after(): void {
    this.running = Math.max(0, this.running - 1);
    this.lastActive = Date.now();
  }

  /** @returns What Settings shows. */
  status(): GuardStatus {
    return {
      config: this.config(),
      cards: this.cards,
      paused: this.paused,
      cooling: this.cooling,
      system: this.sys,
      ...(this.sysHold ? { systemHold: this.sysHold } : {}),
      waiting: this.waiting,
      running: this.running,
      lastActive: new Date(this.lastActive).toISOString(),
      ...(this.lastUnload ? { lastUnload: this.lastUnload } : {}),
    };
  }
}

/**
 * The memory watchdog: every 30 seconds it reads this process's heap and the computer's free memory.
 *
 * - Heap over 85% of its limit: run a garbage collection (when it can) and drop the caches registered with
 *   {@link registerCache}.
 * - Computer free memory under 10%, or heap over 92%: new heavy jobs are refused ({@link HeavyGate.setPressure}),
 *   until memory is back under those lines.
 * - One log line each time a threshold is crossed (not every 30 seconds).
 *
 * Found on the PC: the heap sat at its 467 MB default limit and the computer then powered off.
 */
import { freemem, totalmem } from "node:os";
import { getHeapStatistics, setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { heavyGate, LOW_MEMORY, type HeavyGate, type HeavyLabel } from "./heavy-gate.js";

/** One reading. Bytes. */
export interface MemoryReading {
  heapUsed: number;
  heapLimit: number;
  freeBytes: number;
  totalBytes: number;
}

/** What a reading calls for. */
export interface MemoryVerdict {
  /** Free what can be freed (GC, caches). */
  relieve: boolean;
  /** Refuse new heavy jobs, with the reason. */
  refuse?: HeavyLabel;
}

/** Heap share that starts relieving. */
export const HEAP_RELIEVE = 0.85;
/** Heap share that refuses heavy jobs. */
export const HEAP_REFUSE = 0.92;
/** Free share of the computer's memory under which heavy jobs are refused. */
export const FREE_REFUSE = 0.1;

const caches = new Map<string, () => void>();

/**
 * Registers a cache the watchdog may empty when memory is short (it must refill by itself on the next use).
 *
 * @param name - For the log.
 * @param clear - Empties the cache.
 */
export function registerCache(name: string, clear: () => void): void {
  caches.set(name, clear);
}

/** Empties every registered cache; @returns the names that were emptied. */
export function dropCaches(): string[] {
  const done: string[] = [];
  for (const [name, clear] of caches) {
    try {
      clear();
      done.push(name);
    } catch {
      // a cache that cannot be emptied is left
    }
  }
  return done;
}

/**
 * Decides what a reading calls for.
 *
 * @param r - The reading.
 * @returns Whether to relieve, and whether to refuse heavy jobs (with why).
 */
export function assess(r: MemoryReading): MemoryVerdict {
  const heap = r.heapLimit > 0 ? r.heapUsed / r.heapLimit : 0;
  const free = r.totalBytes > 0 ? r.freeBytes / r.totalBytes : 1;
  const heapRefuse = heap > HEAP_REFUSE;
  const freeRefuse = free < FREE_REFUSE;
  return {
    relieve: heap > HEAP_RELIEVE,
    ...(heapRefuse || freeRefuse ? { refuse: heapRefuse ? { ...LOW_MEMORY, en: `${LOW_MEMORY.en} (KesherAI's heap is ${Math.round(heap * 100)}% full)`, he: `${LOW_MEMORY.he} (הזיכרון של KesherAI מלא ב-${Math.round(heap * 100)}%)` } : LOW_MEMORY } : {}),
  };
}

/** The garbage collector, when this process exposes it or lets it be exposed. */
function collector(): (() => void) | undefined {
  const g = (globalThis as { gc?: () => void }).gc;
  if (g) return g;
  try {
    setFlagsFromString("--expose-gc");
    const fn = runInNewContext("gc") as unknown;
    return typeof fn === "function" ? (fn as () => void) : undefined;
  } catch {
    return undefined;
  }
}

/** Reads the process and the computer now. */
export function readMemory(): MemoryReading {
  const h = getHeapStatistics();
  return { heapUsed: h.used_heap_size, heapLimit: h.heap_size_limit, freeBytes: freemem(), totalBytes: totalmem() };
}

/** What the watchdog needs; the defaults are the real ones (tests pass their own). */
export interface WatchdogOptions {
  /** Writes one log line. */
  log: (line: string) => void;
  read?: () => MemoryReading;
  gate?: HeavyGate;
  gc?: () => void;
  intervalMs?: number;
}

/**
 * Starts the watchdog.
 *
 * @param o - See {@link WatchdogOptions}.
 * @returns `check` (one pass now, for tests) and `stop`.
 */
export function startMemoryWatchdog(o: WatchdogOptions): { check: () => MemoryVerdict; stop: () => void } {
  const read = o.read ?? readMemory;
  const gate = o.gate ?? heavyGate;
  let relieving = false;
  let refusing = false;
  const mb = (b: number) => Math.round(b / 1024 ** 2);
  const check = (): MemoryVerdict => {
    const r = read();
    const v = assess(r);
    const stats = `heap ${mb(r.heapUsed)}/${mb(r.heapLimit)} MB, computer free ${mb(r.freeBytes)} of ${mb(r.totalBytes)} MB`;
    if (v.relieve) {
      (o.gc ?? collector())?.();
      const dropped = dropCaches();
      if (!relieving) o.log(`memory: heap over ${HEAP_RELIEVE * 100}% of its limit (${stats}); ran a garbage collection${dropped.length ? ` and emptied: ${dropped.join(", ")}` : ""}`);
    } else if (relieving) o.log(`memory: heap is back under ${HEAP_RELIEVE * 100}% (${stats})`);
    relieving = v.relieve;
    gate.setPressure(v.refuse);
    if (v.refuse && !refusing) o.log(`memory: new heavy jobs are refused (${stats})`);
    else if (!v.refuse && refusing) o.log(`memory: heavy jobs are allowed again (${stats})`);
    refusing = !!v.refuse;
    return v;
  };
  const timer = setInterval(() => {
    try {
      check();
    } catch {
      // a failed reading is tried again in 30 s
    }
  }, o.intervalMs ?? 30_000);
  timer.unref();
  return { check, stop: () => clearInterval(timer) };
}

let started = false;

/**
 * Starts the watchdog once per process (a second call, e.g. a second server in a test, does nothing).
 *
 * @param log - Writes one log line.
 */
export function ensureMemoryWatchdog(log: (line: string) => void): void {
  if (started) return;
  started = true;
  startMemoryWatchdog({ log });
}

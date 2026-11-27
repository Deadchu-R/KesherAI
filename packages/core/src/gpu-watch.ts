/**
 * The light profile's graphics rule, fed cheaply (heavy-app.ts: "more than 500 MB of video memory and more than 30 % 3D").
 * `Get-Counter` takes seconds, so on NVIDIA cards this asks `nvidia-smi` instead (one short spawn, ~100 ms): first
 * `pmon -c 1 -s um` (per-process sm % and frame-buffer MB, graphics "G" rows included), and where that fails the compute
 * list plus the card's total use. Looks at most every 10 s, never blocks the event loop, and a machine without
 * `nvidia-smi` is detected once and never asked again.
 */
import { execFile } from "node:child_process";
import { parseGpuApps } from "./pc-fix.js";
import { programKey, type GpuProcess } from "./heavy-app.js";

/** One row of `nvidia-smi pmon`. */
export interface PmonRow {
  pid: number;
  /** "G" (graphics), "C" (compute), "C+G", or "" when not shown. */
  type: string;
  /** Streaming-multiprocessor use, percent (0 when "-"). */
  smPct: number;
  /** Frame-buffer memory, MB (0 when "-"). */
  fbMb: number;
  /** The program's name as nvidia-smi prints it (cut short by the driver). */
  command: string;
}

/** A number from a pmon cell: "-" or anything else unreadable is 0. */
const cell = (v: string | undefined): number => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

/**
 * Parses `nvidia-smi pmon -c 1 -s um`. Columns are found by the header line (`# gpu pid type sm mem enc dec ... fb ... command`),
 * since drivers add columns; the command is the rest of the line.
 *
 * @param out - What pmon printed.
 * @returns One row per process (empty when there is none or the output is not pmon's).
 */
export function parsePmon(out: string): PmonRow[] {
  const lines = out.split(/\r?\n/).map((l) => l.trim());
  const head = lines.find((l) => /^#\s*gpu\s+pid\b/i.test(l));
  if (!head) return [];
  const cols = head.replace(/^#\s*/, "").toLowerCase().split(/\s+/);
  const at = (n: string) => cols.indexOf(n);
  const [iPid, iType, iSm, iFb, iCmd] = [at("pid"), at("type"), at("sm"), at("fb"), at("command")];
  if (iPid < 0 || iCmd < 0) return [];
  const rows: PmonRow[] = [];
  for (const l of lines) {
    if (!l || l.startsWith("#")) continue;
    const f = l.split(/\s+/);
    const pid = Number(f[iPid]);
    if (!Number.isInteger(pid) || pid <= 0 || f.length <= iCmd) continue;
    rows.push({ pid, type: iType >= 0 && f[iType] !== "-" ? (f[iType] ?? "") : "", smPct: cell(f[iSm]), fbMb: cell(f[iFb]), command: f.slice(iCmd).join(" ") });
  }
  return rows;
}

/** What the reader needs; tests pass fakes. */
export interface GpuReaderDeps {
  /** Runs `nvidia-smi` with the arguments and resolves its output; rejects when it is missing, fails or times out. */
  smi?: (args: string[]) => Promise<string>;
  /** Process id → name (the game watch's cached list); a name from here beats the driver's cut-short one. */
  names?: () => Map<number, string>;
  /** KesherAI's own engines (llama.cpp, ComfyUI): never counted. */
  ownPids?: () => number[];
  now?: () => number;
}

/** Minimum time between two looks. */
export const GPU_LOOK_MS = 10_000;

/** The real spawn: async, 2 s limit, no window. */
const realSmi = (args: string[]): Promise<string> =>
  new Promise((ok, no) => execFile("nvidia-smi", args, { timeout: 2000, windowsHide: true, maxBuffer: 1024 * 1024 }, (e, out) => (e ? no(e) : ok(String(out)))));

/** Reads the per-process graphics use of an NVIDIA card (see the file's comment). One per server. */
export class GpuReader {
  private last = { at: -Infinity, list: [] as GpuProcess[] };
  /** Not NVIDIA (or no nvidia-smi): set once, then every read is empty with no spawn. */
  private absent = false;
  /** Whether `pmon` worked the last time (false: use the compute list). */
  private pmon = true;
  private busy?: Promise<GpuProcess[]>;

  /** @param d - In tests: fakes for the spawn, the names, the own pids and the clock. */
  constructor(private readonly d: GpuReaderDeps = {}) {}

  /**
   * The processes using the card, at most every 10 s (a look in between returns the last one).
   *
   * @returns The processes (empty when none, when the machine has no NVIDIA card, or on a failure).
   */
  read(): Promise<GpuProcess[]> {
    const now = (this.d.now ?? Date.now)();
    if (this.absent) return Promise.resolve([]);
    if (this.busy) return this.busy;
    if (now - this.last.at < GPU_LOOK_MS) return Promise.resolve(this.last.list);
    this.busy = this.look()
      .catch(() => [] as GpuProcess[])
      .then((list) => ((this.last = { at: now, list }), list))
      .finally(() => (this.busy = undefined));
    return this.busy;
  }

  /** One look: pmon first, else the compute list with the card's total use on the biggest holder. */
  private async look(): Promise<GpuProcess[]> {
    const smi = this.d.smi ?? realSmi;
    const own = new Set(this.d.ownPids?.() ?? []);
    const names = this.d.names?.() ?? new Map<number, string>();
    const nameOf = (pid: number, fallback: string) => names.get(pid) ?? programKey(fallback);
    try {
      if (this.pmon) {
        const rows = parsePmon(await smi(["pmon", "-c", "1", "-s", "um"]));
        return rows.filter((r) => !own.has(r.pid)).map((r) => ({ name: nameOf(r.pid, r.command), vramMb: r.fbMb, gpuPct: r.smPct }));
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        this.absent = true;
        return [];
      }
      this.pmon = false; // an old driver or a card pmon does not cover: the compute list instead
    }
    let apps: ReturnType<typeof parseGpuApps>;
    let total: number;
    try {
      apps = parseGpuApps(await smi(["--query-compute-apps=pid,process_name,used_memory", "--format=csv,noheader,nounits"]));
      total = cell((await smi(["--query-gpu=utilization.gpu", "--format=csv,noheader,nounits"])).split(/\r?\n/)[0]?.trim());
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") this.absent = true;
      return [];
    }
    const list = apps.filter((a) => !own.has(a.pid)).map((a) => ({ pid: a.pid, name: nameOf(a.pid, a.name), vramMb: a.bytes / 1024 ** 2 }));
    // The card's total use cannot be split by process: it goes to the one holding most memory (a game, not a helper).
    const top = list.reduce<(typeof list)[number] | undefined>((b, x) => (!b || x.vramMb > b.vramMb ? x : b), undefined);
    return list.map((x) => ({ name: x.name, vramMb: x.vramMb, gpuPct: x === top ? total : 0 }));
  }
}

/**
 * The automatic light profile (Roee, 27.11: "detect heavy apps and apply a profile automatically"). A detector reads a
 * snapshot every few seconds (a known game from game-watch.ts, the foreground app when it covers the whole screen, and,
 * when it is read, a process using much of the graphics card), and after two looks in a row the PC counts as busy; it is
 * free again after a quiet minute. A controller applies the profile: frees the graphics card's models (the guard's
 * `unloadLoaded`), optionally holds the CPU pool and the task inbox's local runs, and brings the models back when asked.
 * Research: docs/research/r-20261127-02.md.
 */
import { execFile } from "node:child_process";

/** What a program in the per-program list does: always counts as heavy ("light"), or never does ("ignore"). */
export type ProgramRule = "light" | "ignore";

/** The settings (Settings › Computer): `config.lightProfile`. */
export interface LightProfileSettings {
  /** The whole feature. */
  enabled: boolean;
  /** On heavy: unload the models on the graphics card (the guard's free). */
  unloadGpu: boolean;
  /** On heavy: leave the small models on the processor running; off holds them too. */
  keepCpuPool: boolean;
  /** On heavy: the task inbox starts no local runs. */
  pauseInbox: boolean;
  /** When done: load back what was unloaded (otherwise models load when something asks). */
  reloadWhenDone: boolean;
  /** Program (game or process name, lower case, no .exe) → rule. */
  programs: Record<string, ProgramRule>;
}

/** The defaults. */
export const LIGHT_DEFAULTS: LightProfileSettings = { enabled: true, unloadGpu: true, keepCpuPool: true, pauseInbox: false, reloadWhenDone: false, programs: {} };

/** One process using the graphics card (from the per-process GPU counters). */
export interface GpuProcess {
  name: string;
  vramMb: number;
  /** The 3D engine's use, percent. */
  gpuPct: number;
}

/** One look at the computer. */
export interface HeavySnapshot {
  /** Names of the known games running (game-watch.ts). */
  games: string[];
  /** Running process names (to match programs set to "light"). */
  programs?: string[];
  /** The foreground app when it covers its whole screen. */
  fullscreen?: string;
  /** Processes using the graphics card, when it is read. */
  gpu?: GpuProcess[];
}

/** Programs that never count when they fill the screen or use the card: the shell, browsers, editors, KesherAI and its engines. */
export const NOT_HEAVY = new Set([
  "explorer", "dwm", "searchhost", "shellexperiencehost", "applicationframehost", "textinputhost", "lockapp",
  "chrome", "msedge", "firefox", "brave", "opera", "vivaldi", "arc",
  "code", "devenv", "cursor", "windowsterminal", "powershell", "pwsh", "cmd",
  "kesherai", "kesher", "electron", "llama-server", "comfyui", "python", "python3", "ollama", "node",
]);

/** The gate for the graphics rule: more than this much video memory and more than this much 3D use. */
export const GPU_VRAM_MB = 500;
export const GPU_PCT = 30;
/** Looks in a row before it counts, and quiet time before it is over. */
export const HEAVY_AFTER_LOOKS = 2;
export const LIGHT_AFTER_MS = 60_000;

/**
 * A program's key for the list: lower case without the folder or `.exe`.
 *
 * @param name - A process or game name.
 */
export function programKey(name: string): string {
  return name.trim().replace(/^.*[\\/]/, "").replace(/\.exe$/i, "").toLowerCase();
}

/**
 * Which heavy programs the snapshot shows under the rules.
 *
 * @param s - The look.
 * @param programs - The per-program list.
 * @returns Display names, deduplicated (empty when nothing is heavy).
 */
export function heavyHits(s: HeavySnapshot, programs: Record<string, ProgramRule>): string[] {
  const out = new Map<string, string>();
  const add = (name: string) => {
    const k = programKey(name);
    if (k && programs[k] !== "ignore" && !out.has(k)) out.set(k, name.replace(/\.exe$/i, ""));
  };
  for (const g of s.games) add(g);
  for (const p of s.programs ?? []) if (programs[programKey(p)] === "light") add(p);
  if (s.fullscreen && !NOT_HEAVY.has(programKey(s.fullscreen))) add(s.fullscreen);
  for (const g of s.gpu ?? []) if (g.vramMb > GPU_VRAM_MB && g.gpuPct > GPU_PCT && !NOT_HEAVY.has(programKey(g.name))) add(g.name);
  return [...out.values()];
}

/** What the detector says after a look. */
export interface HeavyState {
  heavy: boolean;
  /** The programs that make it heavy (the last look that saw them). */
  apps: string[];
  /** Set only on the look where it changed. */
  changed?: "on" | "off";
}

/** Turns looks into "heavy" / "light" with hysteresis: heavy after two looks in a row, light after a quiet minute. */
export class HeavyAppDetector {
  private streak = 0;
  private quietSince: number | undefined;
  private state = { heavy: false, apps: [] as string[] };

  /**
   * @param now - The clock (tests pass a fake).
   */
  constructor(private readonly now: () => number = Date.now) {}

  /**
   * Takes one look.
   *
   * @param s - The snapshot.
   * @param programs - The per-program list.
   */
  feed(s: HeavySnapshot, programs: Record<string, ProgramRule> = {}): HeavyState {
    const hits = heavyHits(s, programs);
    const t = this.now();
    let changed: HeavyState["changed"];
    if (hits.length) {
      this.streak++;
      this.quietSince = undefined;
      if (this.state.heavy) this.state.apps = hits;
      else if (this.streak >= HEAVY_AFTER_LOOKS) {
        this.state = { heavy: true, apps: hits };
        changed = "on";
      }
    } else {
      this.streak = 0;
      this.quietSince ??= t;
      if (this.state.heavy && t - this.quietSince >= LIGHT_AFTER_MS) {
        this.state = { heavy: false, apps: [] };
        changed = "off";
      }
    }
    return { ...this.state, ...(changed ? { changed } : {}) };
  }

  /** Forgets everything (the feature was turned off). @returns Whether it was heavy. */
  reset(): boolean {
    const was = this.state.heavy;
    this.streak = 0;
    this.quietSince = undefined;
    this.state = { heavy: false, apps: [] };
    return was;
  }
}

/**
 * Checks and merges a settings change from the interface.
 *
 * @param cur - The settings now.
 * @param body - The request body (anything).
 * @returns The new settings; unknown or badly typed fields are ignored, program names are cleaned (at most 200).
 */
export function mergeLightSettings(cur: LightProfileSettings, body: unknown): LightProfileSettings {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const out: LightProfileSettings = { ...cur, programs: { ...cur.programs } };
  for (const k of ["enabled", "unloadGpu", "keepCpuPool", "pauseInbox", "reloadWhenDone"] as const) if (typeof b[k] === "boolean") out[k] = b[k];
  if (b.programs && typeof b.programs === "object" && !Array.isArray(b.programs)) {
    const next: Record<string, ProgramRule> = {};
    for (const [name, rule] of Object.entries(b.programs)) {
      const k = programKey(name.slice(0, 120));
      if (k && (rule === "light" || rule === "ignore") && Object.keys(next).length < 200) next[k] = rule;
    }
    out.programs = next;
  }
  return out;
}

/** What the profile does to the rest of KesherAI (tests pass fakes). */
export interface LightActions {
  /** Unloads the models on the graphics card; the names of what was unloaded. */
  unloadGpu(): Promise<string[]>;
  /** Loads those back. */
  reloadGpu(names: string[]): Promise<void>;
}

/** What the controller reads. */
export interface LightDeps {
  settings(): LightProfileSettings;
  actions: LightActions;
  /** The look at the computer. */
  look(): Promise<HeavySnapshot>;
  now?: () => number;
  log?: (line: string) => void;
}

/** The status the interface shows. */
export interface LightStatus {
  on: boolean;
  enabled: boolean;
  apps: string[];
  /** Models unloaded by the profile, waiting to come back. */
  unloaded: string[];
}

/** Runs the detector on a timer and applies the profile when it changes. */
export class LightProfile {
  private readonly detector: HeavyAppDetector;
  private state: HeavyState = { heavy: false, apps: [] };
  private unloaded: string[] = [];
  private timer?: ReturnType<typeof setInterval>;
  private busy = false;

  /** @param d - The settings, the actions and the look. */
  constructor(private readonly d: LightDeps) {
    this.detector = new HeavyAppDetector(d.now);
  }

  /** Starts looking (one look at a time, never faster than every 5 seconds). @param everyMs - The gap, at least 5000. */
  start(everyMs = 10_000): void {
    this.timer ??= setInterval(() => void this.tick(), Math.max(5000, everyMs));
    this.timer.unref?.();
  }

  /** Stops looking. */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** One look and, when the state changed, the profile's actions. */
  async tick(): Promise<LightStatus> {
    if (this.busy) return this.status();
    this.busy = true;
    try {
      const s = this.d.settings();
      if (!s.enabled) {
        if (this.detector.reset()) await this.leave(s);
        this.state = { heavy: false, apps: [] };
        return this.status();
      }
      this.state = this.detector.feed(await this.d.look().catch(() => ({ games: [] })), s.programs);
      if (this.state.changed === "on") {
        this.d.log?.(`light profile on (${this.state.apps.slice(0, 3).join(", ")})`);
        if (s.unloadGpu) this.unloaded = await this.d.actions.unloadGpu().catch(() => []);
      } else if (this.state.changed === "off") await this.leave(s);
    } finally {
      this.busy = false;
    }
    return this.status();
  }

  private async leave(s: LightProfileSettings): Promise<void> {
    this.d.log?.("light profile off");
    const names = this.unloaded;
    this.unloaded = [];
    if (s.reloadWhenDone && names.length) await this.d.actions.reloadGpu(names).catch(() => undefined);
  }

  /** @returns Whether the light profile is on now. */
  active(): boolean {
    return this.state.heavy;
  }

  /** @returns The programs that make it heavy (empty when light or when the CPU pool stays on). */
  pausesCpuPool(): string[] {
    return this.state.heavy && !this.d.settings().keepCpuPool ? this.state.apps : [];
  }

  /** @returns The programs that hold the task inbox's local runs (empty when light or when the setting is off). */
  pausesInbox(): string[] {
    return this.state.heavy && this.d.settings().pauseInbox ? this.state.apps : [];
  }

  /** @returns What the interface shows. */
  status(): LightStatus {
    return { on: this.state.heavy, enabled: this.d.settings().enabled, apps: this.state.apps, unloaded: this.unloaded };
  }
}

/** The PowerShell that names the foreground app when it covers its whole screen (one spawn per look). */
const FULLSCREEN_PS = `
Add-Type -ReferencedAssemblies System.Windows.Forms -TypeDefinition @"
using System; using System.Runtime.InteropServices; using System.Windows.Forms; using System.Drawing;
public static class KFg {
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [StructLayout(LayoutKind.Sequential)] struct RECT { public int L, T, R, B; }
  public static string Get() {
    IntPtr h = GetForegroundWindow(); RECT r; uint pid;
    if (h == IntPtr.Zero || !GetWindowRect(h, out r)) return "";
    Rectangle b = Screen.FromHandle(h).Bounds;
    if (r.L > b.Left || r.T > b.Top || r.R < b.Right || r.B < b.Bottom) return "";
    GetWindowThreadProcessId(h, out pid);
    return System.Diagnostics.Process.GetProcessById((int)pid).ProcessName;
  }
}
"@
[KFg]::Get()
`;

/**
 * The foreground app's name when it covers its whole screen (Windows only; elsewhere and on any failure: undefined).
 * Compiles a small helper each time, so call it no more often than every few seconds and never twice at once.
 */
export function readFullscreen(): Promise<string | undefined> {
  if (process.platform !== "win32") return Promise.resolve(undefined);
  return new Promise((ok) =>
    execFile("powershell", ["-NoProfile", "-NonInteractive", "-Command", FULLSCREEN_PS], { windowsHide: true, timeout: 15_000 }, (_e, out) => ok(String(out ?? "").trim() || undefined)),
  );
}

/**
 * Per-process graphics use from `Get-Counter` output lines of the form `pid_<pid>_...<TAB>value` (for the GPU Process
 * Memory dedicated usage in bytes and the 3D engine's utilization). Pure, so it is tested; the reader that would feed it
 * is not wired yet (Get-Counter takes seconds per call: measure on the PC first).
 *
 * @param mem - Lines `instance<TAB>bytes`.
 * @param util - Lines `instance<TAB>percent` for 3D engines.
 * @param names - Process id → name.
 */
export function parseGpuCounters(mem: string[], util: string[], names: Map<number, string>): GpuProcess[] {
  const pidOf = (inst: string) => Number(/pid_(\d+)/i.exec(inst)?.[1]);
  const by = new Map<number, GpuProcess>();
  const get = (pid: number) => by.get(pid) ?? (by.set(pid, { name: names.get(pid) ?? `pid ${pid}`, vramMb: 0, gpuPct: 0 }), by.get(pid)!);
  for (const l of mem) {
    const [inst = "", v = ""] = l.split("\t");
    const pid = pidOf(inst);
    if (Number.isFinite(pid)) get(pid).vramMb += Number(v) / 1024 ** 2 || 0;
  }
  for (const l of util) {
    const [inst = "", v = ""] = l.split("\t");
    const pid = pidOf(inst);
    if (Number.isFinite(pid) && /engtype_3D/i.test(inst)) get(pid).gpuPct += Number(v) || 0;
  }
  return [...by.values()];
}

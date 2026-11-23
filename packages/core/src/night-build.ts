import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { isFree, type FreeState } from "./install-when-free.js";

/**
 * Night builds of game projects with a morning scorecard (RESEARCH_LOG 2026-11-21, deep research c-20261121-38,
 * Part D idea 6). Off by default, per project: at the set time (default 02:00), if the computer is idle and the
 * engine's editor is not open on that project, the game is built headless for each chosen platform, with an optional
 * smoke test. Each build keeps its log, duration, size, warning and error counts and the smoke result; the last
 * {@link KEEP_BUILDS} per project stay in KesherAI's own data folder (never inside the project). In the morning
 * (07:00, or earlier at the first sign the user is active) one scorecard goes out as a desktop and phone notification
 * and shows on the Games page; a failure opens its log trimmed to the errors.
 *
 * This file is the engine-neutral part: settings, scheduling, the idle check, counting and trimming logs, the
 * scorecard, and the loop. The real builds (RunUAT, Unity's CLI) are in night-build-runners.ts and come in as a
 * {@link NightRunner}, so everything here runs in tests without an engine.
 */

/** Builds kept per project. */
export const KEEP_BUILDS = 7;
/** How long after the set time a build may still start (a busy night is skipped, not built at breakfast). */
export const START_WINDOW_MIN = 5 * 60;
/** The scorecard goes out at this hour at the latest. */
export const MORNING_HOUR = 7;
/** The first sign of the user before this hour does not send it yet (the user up at 3 am should not get it). */
export const EARLIEST_ACTIVE_HOUR = 5;
/** The generic smoke test runs the built game this long. */
export const SMOKE_SECONDS = 30;

/** A platform a night build can target. */
export type NightPlatform = "windows" | "android";
/** The engines KesherAI builds. */
export type NightEngine = "unity" | "unreal";

/** One project's night-build setting. */
export interface NightSettings {
  enabled: boolean;
  /** Local time "HH:MM". */
  time: string;
  platforms: NightPlatform[];
  /** Run the smoke test after a good build. */
  smoke: boolean;
}

/** The setting of a project that was never set: off. */
export const NIGHT_DEFAULTS: NightSettings = { enabled: false, time: "02:00", platforms: ["windows"], smoke: true };

/**
 * Minutes after midnight of an "HH:MM" text.
 *
 * @param t - The text.
 * @returns The minutes, or undefined when it is not a time.
 */
export function parseTime(t: unknown): number | undefined {
  const m = typeof t === "string" ? /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(t.trim()) : null;
  return m ? Number(m[1]) * 60 + Number(m[2]) : undefined;
}

/**
 * A setting from untrusted input (the phone or the page): unknown fields are dropped, bad values fall back to the
 * current ones.
 *
 * @param raw - The input.
 * @param base - The setting it changes.
 * @param can - The platforms this project can build here (others are dropped).
 */
export function readSettings(raw: unknown, base: NightSettings = NIGHT_DEFAULTS, can: readonly NightPlatform[] = ["windows", "android"]): NightSettings {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const min = parseTime(r.time);
  const platforms = Array.isArray(r.platforms) ? (["windows", "android"] as const).filter((p) => (r.platforms as unknown[]).includes(p) && can.includes(p)) : base.platforms;
  return {
    enabled: typeof r.enabled === "boolean" ? r.enabled : base.enabled,
    time: min === undefined ? base.time : `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`,
    platforms: platforms.length ? [...platforms] : base.platforms,
    smoke: typeof r.smoke === "boolean" ? r.smoke : base.smoke,
  };
}

/** A local date as YYYY-MM-DD. */
export function dayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * The night slot a build is due for now: the date of the set time, while now is within {@link START_WINDOW_MIN} after
 * it. Today's and yesterday's slots are both looked at, so 23:00 still runs at 00:30.
 *
 * @param s - The setting.
 * @param now - The time now (local).
 * @returns The slot's date (YYYY-MM-DD), or undefined when it is not time.
 */
export function dueSlot(s: Pick<NightSettings, "time">, now: Date): string | undefined {
  const min = parseTime(s.time);
  if (min === undefined) return undefined;
  for (const back of [0, 1]) {
    const at = new Date(now.getFullYear(), now.getMonth(), now.getDate() - back, Math.floor(min / 60), min % 60);
    const late = (now.getTime() - at.getTime()) / 60_000;
    if (late >= 0 && late <= START_WINDOW_MIN) return dayKey(at);
  }
  return undefined;
}

/** What the night build looks at before it starts. */
export interface IdleState extends FreeState {
  /** The engine's editor is open on this project. */
  editorOpen: boolean;
  /** The graphics-card guard is cooling, paused, or holding work for the computer's memory or processor. */
  guardHold?: boolean;
  /** A game plays in an editor (Free for Play). */
  playing?: boolean;
}

/**
 * Why a build must wait now (the same free check as "install when free", plus the editor and the guard).
 *
 * @param s - What is busy.
 * @returns Why it waits, or undefined when the computer is idle.
 */
export function holdReason(s: IdleState): "editor" | "busy" | undefined {
  if (s.editorOpen) return "editor";
  return isFree(s) && !s.guardHold && !s.playing ? undefined : "busy";
}

/** One platform's build of one night. */
export interface NightResult {
  id: string;
  /** The night's slot date. */
  slot: string;
  project: string;
  name: string;
  engine: NightEngine;
  platform: NightPlatform;
  startedAt: string;
  durationMs: number;
  ok: boolean;
  sizeBytes?: number;
  warnings: number;
  errors: number;
  /** The smoke test: absent when not asked or the build failed. */
  smoke?: { ok: boolean; note: string };
  /** The project's HEAD then, and the commits since the last build (short hash and subject). */
  commit?: string;
  changes: string[];
  /** The full log. */
  logFile: string;
  /** The built game's folder (kept for the last builds). */
  outputDir?: string;
  /** Sent in a scorecard already. */
  reported?: boolean;
  /** The APK was installed on the phone after a successful Android build. */
  phoneInstalled?: boolean;
}

/**
 * Warnings and errors in a build log. Summary lines such as "0 error(s)" and "Errors: 0" are not counted.
 *
 * @param log - The log's text.
 */
export function countIssues(log: string): { warnings: number; errors: number } {
  let warnings = 0;
  let errors = 0;
  for (const line of log.split(/\r?\n/)) {
    if (/\b0 (errors?|warnings?)\b|\b(errors?|warnings?)[:=]\s*0\b|\bno (errors?|warnings?)\b/i.test(line)) continue;
    if (/\berror\b|\bfatal\b|\bexception\b|\bfailed\b/i.test(line)) errors++;
    else if (/\bwarning\b/i.test(line)) warnings++;
  }
  return { warnings, errors };
}

const MAX_TRIM_LINES = 80;
const MAX_TRIM_CHARS = 12_000;

/**
 * The log cut down to what went wrong: the error lines, each distinct one once (a broken header repeats in every file),
 * with the line before the first for context; the last lines when there are none.
 *
 * @param log - The full log.
 * @returns The lines, and whether the log has errors at all.
 */
export function trimLog(log: string): { text: string; errors: boolean } {
  const lines = log.split(/\r?\n/);
  const seen = new Set<string>();
  const out: string[] = [];
  lines.forEach((l, i) => {
    if (!/\berror\b|\bfatal\b|\bexception\b|\bfailed\b|\bcrash/i.test(l) || /\b0 errors?\b|\berrors?[:=]\s*0\b/i.test(l)) return;
    const key = l.replace(/^\[[^\]]*\]\[\s*\d+\]/, "").replace(/\d+/g, "#").trim();
    if (seen.has(key)) return;
    seen.add(key);
    if (!out.length && i > 0 && lines[i - 1]!.trim()) out.push(lines[i - 1]!.trim());
    out.push(l.trim());
  });
  if (!out.length) return { text: lines.filter((l) => l.trim()).slice(-30).join("\n"), errors: false };
  const text = out.slice(0, MAX_TRIM_LINES).join("\n");
  return { text: text.length > MAX_TRIM_CHARS ? `${text.slice(0, MAX_TRIM_CHARS)}\n…` : text, errors: true };
}

/** One row of the scorecard. */
export interface ScoreRow {
  id: string;
  project: string;
  name: string;
  engine: NightEngine;
  platform: NightPlatform;
  ok: boolean;
  durationMs: number;
  sizeBytes?: number;
  warnings: number;
  errors: number;
  smoke?: { ok: boolean; note: string };
  changes: string[];
  /** The APK was installed on the phone after a successful Android build. */
  phoneInstalled?: boolean;
}

/** The morning scorecard. */
export interface Scorecard {
  /** The night's slot date of the newest build. */
  night: string;
  rows: ScoreRow[];
  passed: number;
  failed: number;
}

/**
 * The scorecard of some results: one row per project and platform, the newest build of each.
 *
 * @param results - Results, any order.
 * @returns The card, or undefined when there are none.
 */
export function buildScorecard(results: readonly NightResult[]): Scorecard | undefined {
  const latest = new Map<string, NightResult>();
  for (const r of [...results].sort((a, b) => a.startedAt.localeCompare(b.startedAt))) latest.set(`${r.project}\u0000${r.platform}`, r);
  const rows = [...latest.values()]
    .map((r): ScoreRow => ({ id: r.id, project: r.project, name: r.name, engine: r.engine, platform: r.platform, ok: r.ok && r.smoke?.ok !== false, durationMs: r.durationMs, ...(r.sizeBytes !== undefined ? { sizeBytes: r.sizeBytes } : {}), warnings: r.warnings, errors: r.errors, ...(r.smoke ? { smoke: r.smoke } : {}), changes: r.changes, ...(r.phoneInstalled !== undefined ? { phoneInstalled: r.phoneInstalled } : {}) }))
    .sort((a, b) => Number(a.ok) - Number(b.ok) || a.name.localeCompare(b.name));
  if (!rows.length) return undefined;
  const night = [...latest.values()].map((r) => r.slot).sort().pop()!;
  return { night, rows, passed: rows.filter((r) => r.ok).length, failed: rows.filter((r) => !r.ok).length };
}

/** A duration as "41m" or "1h 05m". */
export function durationText(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000));
  return m >= 60 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m` : `${m}m`;
}

/** A size as "340 MB" or "1.2 GB". */
export function sizeText(n: number): string {
  return n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : `${Math.max(1, Math.round(n / 1024 ** 2))} MB`;
}

/**
 * The scorecard as a notification. The body uses symbols and units that read the same in Hebrew and English; only the
 * title carries both languages.
 *
 * @param c - The card.
 */
export function scorecardNote(c: Scorecard): { title: string; body: string } {
  const mark = c.failed ? `✕ ${c.failed} · ✓ ${c.passed}` : `✓ ${c.passed}`;
  const lines = c.rows.map((r) => `${r.ok ? "✓" : "✕"} ${r.name} (${r.platform === "android" ? "Android" : "Windows"}) · ${durationText(r.durationMs)}${r.sizeBytes ? ` · ${sizeText(r.sizeBytes)}` : ""} · ⚠ ${r.warnings}${r.smoke ? ` · smoke ${r.smoke.ok ? "✓" : "✕"}` : ""}`);
  return { title: `בניית לילה · Night build ${mark}`, body: lines.join("\n") };
}

/** A project's settings and every kept result, in one JSON file in KesherAI's data folder. */
interface StoreFile {
  settings: Record<string, NightSettings & { path: string }>;
  results: NightResult[];
}

/** The key of a project folder (case-insensitive on Windows). */
export const projectKey = (path: string): string => (process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path));

/** A folder name for a project: its name and a short hash of its folder. */
export const projectSlug = (name: string, path: string): string => `${name.replace(/[^\w-]+/g, "_").slice(0, 40) || "game"}-${createHash("sha1").update(projectKey(path)).digest("hex").slice(0, 8)}`;

/** Where night-build settings and results are kept (KesherAI's data folder, never inside a project). */
export class NightStore {
  private data: StoreFile | undefined;
  private chain: Promise<unknown> = Promise.resolve();
  /**
   * @param file - The JSON file.
   */
  constructor(private readonly file: string) {}

  private async load(): Promise<StoreFile> {
    if (this.data) return this.data;
    const raw = JSON.parse(await readFile(this.file, "utf8").catch(() => "{}")) as Partial<StoreFile>;
    this.data = { settings: raw.settings ?? {}, results: Array.isArray(raw.results) ? raw.results : [] };
    return this.data;
  }

  private save(): Promise<void> {
    const run = this.chain.then(async () => {
      await mkdir(dirname(this.file), { recursive: true });
      await writeFile(`${this.file}.tmp`, JSON.stringify(this.data));
      await rename(`${this.file}.tmp`, this.file);
    });
    this.chain = run.catch(() => undefined);
    return run;
  }

  /** @param project - The project folder. @returns Its setting (off when never set). */
  async settings(project: string): Promise<NightSettings> {
    const s = (await this.load()).settings[projectKey(project)];
    return s ? { enabled: s.enabled, time: s.time, platforms: s.platforms, smoke: s.smoke } : { ...NIGHT_DEFAULTS };
  }

  /** @param project - The project folder. @param s - The checked setting to keep. */
  async setSettings(project: string, s: NightSettings): Promise<void> {
    (await this.load()).settings[projectKey(project)] = { ...s, path: resolve(project) };
    await this.save();
  }

  /** @returns The folders of the projects whose night build is on. */
  async enabled(): Promise<string[]> {
    return Object.values((await this.load()).settings).filter((s) => s.enabled).map((s) => s.path);
  }

  /** @param project - Only this project's results. @returns Results, newest first. */
  async results(project?: string): Promise<NightResult[]> {
    const all = (await this.load()).results;
    return (project ? all.filter((r) => projectKey(r.project) === projectKey(project)) : [...all]).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  /**
   * Adds a result and drops the oldest of that project beyond {@link KEEP_BUILDS}, with their logs and built games.
   *
   * @param r - The result.
   * @returns The results removed.
   */
  async add(r: NightResult): Promise<NightResult[]> {
    const d = await this.load();
    d.results.push(r);
    const mine = d.results.filter((x) => projectKey(x.project) === projectKey(r.project)).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    const drop = mine.slice(KEEP_BUILDS);
    d.results = d.results.filter((x) => !drop.includes(x));
    await this.save();
    for (const x of drop) await Promise.all([rm(x.logFile, { force: true }), x.outputDir ? rm(x.outputDir, { recursive: true, force: true }) : undefined]).catch(() => undefined);
    return drop;
  }

  /** @param ids - Results that went out in a scorecard. */
  async markReported(ids: string[]): Promise<void> {
    for (const r of (await this.load()).results) if (ids.includes(r.id)) r.reported = true;
    await this.save();
  }
}

/** What the runner is asked to build. */
export interface NightRequest {
  engine: NightEngine;
  project: string;
  name: string;
  platform: NightPlatform;
  /** Where the game goes (outside the project). */
  outDir: string;
  /** Where to write the log while it runs. */
  logFile: string;
  smoke: boolean;
}

/** What the runner did. */
export interface NightRun {
  ok: boolean;
  /** The build's output (the loop keeps it in the log file and counts its warnings and errors). */
  log: string;
  sizeBytes?: number;
  smoke?: { ok: boolean; note: string };
}

/** Builds one platform of one project, headless. */
export type NightRunner = (r: NightRequest) => Promise<NightRun>;

/** What the loop needs from KesherAI. */
export interface NightDeps {
  store: NightStore;
  runner: NightRunner;
  /** The projects found on this computer (the phone can only name these). */
  projects: () => Promise<Array<{ kind: string; name: string; path: string }>>;
  /** What is busy now for this project. */
  idle: (project: string) => Promise<IdleState>;
  /** The commits since the last build: short hash and subject; `head` is the commit now. */
  changes: (project: string, since?: string) => Promise<{ head?: string; lines: string[] }>;
  /** Where a build's folder goes: `<heavy data>/night-builds/<slug>/<id>`. */
  outDir: (name: string, project: string, id: string) => string;
  /** Sends the scorecard (desktop and phone). */
  notify: (card: Scorecard, note: { title: string; body: string }) => void | Promise<unknown>;
  /** The user did something in KesherAI lately (a chat is working, the app was used). */
  active: () => boolean;
  now?: () => Date;
  /** How often to look, in ms (default 60 s). */
  everyMs?: number;
}

/** What the page shows about the loop. */
export interface NightStatus {
  /** A build running now. */
  running?: { project: string; platform: NightPlatform; since: string };
  /** Projects that are due but wait, and why. */
  waiting: Record<string, "editor" | "busy">;
}

/** Runs the night builds and sends the morning scorecard. */
export class NightBuilds {
  private timer: ReturnType<typeof setInterval> | undefined;
  private busy = false;
  private run: NightStatus["running"];
  private waiting = new Map<string, "editor" | "busy">();
  /**
   * @param deps - The store, the runner and what to look at.
   */
  constructor(private readonly deps: NightDeps) {}

  /** Starts looking every minute. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.deps.everyMs ?? 60_000);
    this.timer.unref?.();
  }

  /** Stops looking (a build that runs goes on to its end). */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** @returns What runs now and what waits. */
  status(): NightStatus {
    return { ...(this.run ? { running: this.run } : {}), waiting: Object.fromEntries(this.waiting) };
  }

  /**
   * One look: starts the builds that are due and idle, then sends the scorecard when it is morning.
   *
   * @returns Whether it built or reported anything.
   */
  async tick(): Promise<boolean> {
    if (this.busy) return false;
    this.busy = true;
    try {
      const now = (this.deps.now ?? (() => new Date()))();
      let did = false;
      for (const path of await this.deps.store.enabled()) {
        const s = await this.deps.store.settings(path);
        const slot = dueSlot(s, now);
        if (!slot) {
          this.waiting.delete(projectKey(path));
          continue;
        }
        const have = await this.deps.store.results(path);
        if (have.some((r) => r.slot === slot)) continue;
        const found = (await this.deps.projects()).find((p) => projectKey(p.path) === projectKey(path) && (p.kind === "unity" || p.kind === "unreal"));
        if (!found) continue;
        const hold = holdReason(await this.deps.idle(path));
        if (hold) {
          this.waiting.set(projectKey(path), hold);
          continue;
        }
        this.waiting.delete(projectKey(path));
        await this.buildProject(found.kind as NightEngine, found.name, path, s, slot, have[0]);
        did = true;
      }
      return (await this.report(now)) || did;
    } catch {
      return false;
    } finally {
      this.busy = false;
    }
  }

  /** Builds each chosen platform of one project in turn (stops at the first idle check that fails mid-night). */
  private async buildProject(engine: NightEngine, name: string, path: string, s: NightSettings, slot: string, last: NightResult | undefined): Promise<void> {
    const ch = await this.deps.changes(path, last?.commit).catch((): { head?: string; lines: string[] } => ({ lines: [] }));
    for (const platform of s.platforms) {
      const started = (this.deps.now ?? (() => new Date()))();
      const id = `${started.getTime().toString(36)}-${platform}`;
      const outDir = this.deps.outDir(name, path, id);
      const logFile = join(dirname(outDir), `${id}.log`);
      await mkdir(dirname(outDir), { recursive: true });
      this.run = { project: path, platform, since: started.toISOString() };
      let out: NightRun;
      try {
        out = await this.deps.runner({ engine, project: path, name, platform, outDir, logFile, smoke: s.smoke });
      } catch (e) {
        out = { ok: false, log: `Error: ${e instanceof Error ? e.message : String(e)}` };
      }
      this.run = undefined;
      await writeFile(logFile, out.log.slice(-2_000_000)).catch(() => undefined);
      const { warnings, errors } = countIssues(out.log);
      await this.deps.store.add({
        id, slot, project: path, name, engine, platform,
        startedAt: started.toISOString(),
        durationMs: Math.max(0, (this.deps.now ?? (() => new Date()))().getTime() - started.getTime()),
        ok: out.ok, ...(out.sizeBytes !== undefined ? { sizeBytes: out.sizeBytes } : {}),
        warnings, errors, ...(out.smoke ? { smoke: out.smoke } : {}),
        ...(ch.head ? { commit: ch.head } : {}), changes: ch.lines, logFile, ...(out.ok ? { outputDir: outDir } : {}),
      });
      if (!out.ok) await rm(outDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /**
   * Sends the scorecard of the results not reported yet, from 07:00 or at the first sign of the user after 05:00.
   *
   * @param now - The time now.
   * @returns Whether it sent one.
   */
  async report(now: Date): Promise<boolean> {
    const fresh = (await this.deps.store.results()).filter((r) => !r.reported);
    if (!fresh.length || this.run) return false;
    const h = now.getHours();
    if (!(h >= MORNING_HOUR || (h >= EARLIEST_ACTIVE_HOUR && this.deps.active()))) return false;
    const card = buildScorecard(fresh);
    if (!card) return false;
    await this.deps.store.markReported(fresh.map((r) => r.id));
    await Promise.resolve(this.deps.notify(card, scorecardNote(card))).catch(() => undefined);
    return true;
  }
}

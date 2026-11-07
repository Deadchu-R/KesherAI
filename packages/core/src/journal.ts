import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelTurn } from "@kesher/agent";
import { isSensitiveWindow, screenBackend } from "./computer.js";

/**
 * "My day": an opt-in journal of what was on this computer's screen, kept
 * only on this computer. Every half minute (while the user is active) it
 * saves a small picture of the screen, the app and window in front, and the
 * text on screen (Windows' built-in OCR, no download). Every quarter hour a
 * model (local by default) turns that into short observations, action items
 * and the people, projects and companies involved.
 *
 * It skips password managers, private browser windows, sign-in, bank and
 * payment windows, the apps the user excludes, and the locked screen. Frames
 * are deleted after a week and text after three months, unless the user
 * picks otherwise; any day can be deleted.
 */

/** Saved settings. */
export interface JournalSettings {
  enabled: boolean;
  /** Seconds between captures. */
  intervalSec: number;
  /** App names (process names) never captured. */
  excludeApps: string[];
  keepFramesDays: number;
  keepTextDays: number;
  /** Model that writes the observations; empty = the active chat model. */
  modelId?: string;
  /** Let a cloud model read the screen text (off: only models on this computer). */
  allowCloud: boolean;
  /** Paused until this time (ms). */
  pausedUntil?: number;
}

/** One capture. */
export interface Capture {
  /** Time (ms). */
  t: number;
  app: string;
  title: string;
  /** Text read off the screen. */
  text?: string;
  /** The picture's file name in that day's folder. */
  frame?: string;
  /** The user was away (no input for a while). */
  idle?: boolean;
  /** Not captured because of a rule (sensitive window, excluded app). */
  skipped?: string;
}

/** What the model found in a stretch of time. */
export interface Observation {
  id: string;
  t0: number;
  t1: number;
  text: string;
  /** Meeting, focus, browsing… */
  kind?: string;
}

/** Something to do that the model noticed. */
export interface ActionItem {
  id: string;
  t: number;
  text: string;
  /** Who asked, or who it is for. */
  who?: string;
  state: "open" | "done" | "dismissed";
}

/** A person, project, company or idea that keeps appearing. */
export interface Entity {
  id: string;
  name: string;
  kind: "person" | "project" | "company" | "concept";
  summary?: string;
  /** Other names merged into this one. */
  aliases: string[];
  parent?: string;
  hidden?: boolean;
  /** Days it appeared on. */
  days: string[];
  lastSeen: number;
}

/** A day's model output. */
export interface DayInsights {
  observations: Observation[];
  actions: ActionItem[];
  /** Captures up to this time have been summarized. */
  summarizedTo: number;
  error?: string;
}

/** A recorded meeting: what was said, and the write-up. */
export interface Meeting {
  id: string;
  title: string;
  t0: number;
  t1?: number;
  /** What was said, in order (each piece is about half a minute). */
  segments: Array<{ t: number; text: string }>;
  summary?: string;
  decisions?: string[];
  /** Ids of the action items it added to the day. */
  actionIds?: string[];
  error?: string;
}

/** Time per app and focus figures for a day. */
export interface DayStats {
  activeMinutes: number;
  apps: Array<{ app: string; minutes: number }>;
  /** How many times the app in front changed. */
  switches: number;
  /** The longest stretch in one app, in minutes. */
  longestFocus: { app: string; minutes: number };
  /** Meetings found from window titles. */
  meetings: Array<{ t0: number; t1: number; title: string }>;
  /** Active minutes per hour (0–23). */
  hours: number[];
}

const DEFAULTS: JournalSettings = { enabled: false, intervalSec: 30, excludeApps: [], keepFramesDays: 7, keepTextDays: 90, allowCloud: false };

/** Apps never captured, whatever the user sets. */
const ALWAYS_EXCLUDED = /^(1password|bitwarden|keepass(xc)?|lastpass|dashlane|nordpass|enpass|keeper|lockapp|logonui|consent|credentialuibroker)$/i;
const PRIVATE_WINDOW = /(inprivate|incognito|private browsing|גלישה בסתר|פרטי)/i;
const MEETING = /(zoom meeting|zoom workplace|microsoft teams|\| microsoft teams|meet\.google|google meet|webex|skype|discord.*voice|slack.*huddle)/i;

/** Local day key, `YYYY-MM-DD`. */
export function dayKey(t: number): string {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * Whether a window must not be captured.
 *
 * @param app - Process name.
 * @param title - Window title.
 * @param exclude - The user's excluded apps.
 * @returns Why, or undefined when it may be captured.
 */
export function skipReason(app: string, title: string, exclude: string[]): string | undefined {
  const a = app.replace(/\.exe$/i, "");
  if (ALWAYS_EXCLUDED.test(a)) return "password-manager";
  if (exclude.some((x) => x.trim() && x.trim().replace(/\.exe$/i, "").toLowerCase() === a.toLowerCase())) return "excluded";
  if (PRIVATE_WINDOW.test(title)) return "private-window";
  if (isSensitiveWindow(title)) return "sensitive";
  return undefined;
}

/**
 * Works out time per app, focus and meetings from a day's captures.
 *
 * @param caps - The day's captures, in order.
 * @param intervalSec - Seconds between captures (each capture counts for that long, at most).
 * @returns The figures.
 */
export function dayStats(caps: Capture[], intervalSec: number): DayStats {
  const per = new Map<string, number>();
  const hours = Array.from({ length: 24 }, () => 0);
  const meetings: DayStats["meetings"] = [];
  let switches = 0;
  let prev = "";
  let run = { app: "", start: 0, end: 0 };
  let longest = { app: "", minutes: 0 };
  let active = 0;
  for (let i = 0; i < caps.length; i++) {
    const c = caps[i]!;
    if (c.idle) {
      prev = "";
      continue;
    }
    const next = caps[i + 1];
    const dur = Math.min(intervalSec * 1000 * 1.5, next ? next.t - c.t : intervalSec * 1000) / 60000;
    active += dur;
    const app = c.app || "?";
    per.set(app, (per.get(app) ?? 0) + dur);
    hours[new Date(c.t).getHours()]! += dur;
    if (prev && app !== prev) switches++;
    if (app !== run.app) run = { app, start: c.t, end: c.t };
    run.end = c.t + dur * 60000;
    const len = (run.end - run.start) / 60000;
    if (len > longest.minutes) longest = { app, minutes: len };
    prev = app;
    if (MEETING.test(`${c.app} ${c.title}`)) {
      const last = meetings.at(-1);
      if (last && c.t - last.t1 < 5 * 60000) last.t1 = c.t + dur * 60000;
      else meetings.push({ t0: c.t, t1: c.t + dur * 60000, title: c.title || c.app });
    }
  }
  const r = (n: number) => Math.round(n * 10) / 10;
  return {
    activeMinutes: r(active),
    apps: [...per].map(([app, minutes]) => ({ app, minutes: r(minutes) })).sort((a, b) => b.minutes - a.minutes),
    switches,
    longestFocus: { app: longest.app, minutes: r(longest.minutes) },
    meetings: meetings.filter((m) => m.t1 - m.t0 >= 2 * 60000),
    hours: hours.map(r),
  };
}

/**
 * Reads the model's JSON answer, tolerating code fences and extra words.
 *
 * @param text - The model's answer.
 * @returns The parsed parts.
 */
export function parseInsights(text: string): {
  observations: Array<{ from?: string; to?: string; text: string; kind?: string }>;
  actions: Array<{ text: string; who?: string }>;
  entities: Array<{ name: string; kind?: string; note?: string }>;
} {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  const empty = { observations: [], actions: [], entities: [] };
  if (start < 0 || end <= start) return empty;
  try {
    const j = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
    const arr = <T>(v: unknown) => (Array.isArray(v) ? (v as T[]) : []);
    return {
      observations: arr<{ from?: string; to?: string; text: string; kind?: string }>(j.observations).filter((o) => typeof o?.text === "string"),
      actions: arr<{ text: string; who?: string }>(j.actions).filter((a) => typeof a?.text === "string"),
      entities: arr<{ name: string; kind?: string; note?: string }>(j.entities).filter((e) => typeof e?.name === "string" && e.name.trim().length > 1),
    };
  } catch {
    return empty;
  }
}

/**
 * Reads the model's meeting write-up.
 *
 * @param text - The model's answer.
 * @returns Summary, decisions and actions.
 */
export function parseMeeting(text: string): { summary: string; decisions: string[]; actions: Array<{ text: string; who?: string }> } {
  const a = text.indexOf("{");
  const b = text.lastIndexOf("}");
  try {
    const j = JSON.parse(text.slice(a, b + 1)) as { summary?: unknown; decisions?: unknown; actions?: unknown };
    return {
      summary: typeof j.summary === "string" ? j.summary.slice(0, 3000) : "",
      decisions: Array.isArray(j.decisions) ? j.decisions.filter((d): d is string => typeof d === "string").slice(0, 30) : [],
      actions: Array.isArray(j.actions) ? (j.actions as Array<{ text?: unknown; who?: unknown }>).filter((x) => typeof x?.text === "string").map((x) => ({ text: String(x.text), ...(typeof x.who === "string" && x.who ? { who: x.who } : {}) })) : [],
    };
  } catch {
    return { summary: text.trim().slice(0, 3000), decisions: [], actions: [] };
  }
}

function run(cmd: string, args: string[], timeout = 45_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${cmd}: ${(stderr || err.message).toString().trim().slice(0, 300)}`));
      else resolve(stdout.toString());
    });
  });
}

/** One capture on Windows: idle time, window, picture and OCR, in a single PowerShell run. */
async function windowsCapture(frame: string, idleSec: number, excludePattern: string): Promise<Capture & { hash?: string }> {
  const out = join(tmpdir(), `kesher-journal-${randomUUID()}.json`);
  const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms, System.Drawing, System.Runtime.WindowsRuntime
Add-Type @'
using System; using System.Runtime.InteropServices; using System.Text;
public static class J {
  [StructLayout(LayoutKind.Sequential)] public struct LII { public uint cbSize; public uint dwTime; }
  [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LII p);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  public static uint Idle() { var l = new LII(); l.cbSize = (uint)Marshal.SizeOf(l); GetLastInputInfo(ref l); return ((uint)Environment.TickCount - l.dwTime) / 1000; }
}
'@
[J]::SetProcessDPIAware() | Out-Null
$r = @{}
$r.idle = [J]::Idle()
$h = [J]::GetForegroundWindow(); $sb = New-Object System.Text.StringBuilder 512; [J]::GetWindowText($h, $sb, 512) | Out-Null
$p = 0; [J]::GetWindowThreadProcessId($h, [ref]$p) | Out-Null
$r.app = [string](Get-Process -Id $p -ErrorAction SilentlyContinue).ProcessName
$r.title = $sb.ToString()
$skip = ($r.app -match ${q(excludePattern)}) -or ($r.title -match ${q(excludePattern)})
if ($r.idle -lt ${idleSec} -and -not $skip) {
  $b = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
  $g = [System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size); $g.Dispose()
  # A tiny grey version to notice when nothing changed.
  $tiny = New-Object System.Drawing.Bitmap $bmp, 32, 18
  $px = New-Object System.Text.StringBuilder
  for ($y = 0; $y -lt 18; $y++) { for ($x = 0; $x -lt 32; $x++) { $c = $tiny.GetPixel($x, $y); [void]$px.Append([char](65 + [int](($c.R + $c.G + $c.B) / 48))) } }
  $r.hash = $px.ToString()
  $scale = [Math]::Min(1.0, 1280 / $b.Width)
  $small = New-Object System.Drawing.Bitmap $bmp, ([int]($b.Width * $scale)), ([int]($b.Height * $scale))
  $enc = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
  $ep = New-Object System.Drawing.Imaging.EncoderParameters 1
  $ep.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality), ([long]55)
  $small.Save(${q(frame)}, $enc, $ep)
  # Text on screen, with Windows' own OCR (the user's languages).
  try {
    $png = [IO.Path]::ChangeExtension(${q(frame)}, '.ocr.png')
    $bmp.Save($png, [System.Drawing.Imaging.ImageFormat]::Png)
    $asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' })[0]
    function Await($op, $type) { $t = $asTask.MakeGenericMethod($type).Invoke($null, @($op)); $t.Wait(-1) | Out-Null; $t.Result }
    [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime] | Out-Null
    [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
    [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType = WindowsRuntime] | Out-Null
    $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($png)) ([Windows.Storage.StorageFile])
    $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
    $dec = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $sbmp = Await ($dec.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
    $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
    if ($engine) { $res = Await ($engine.RecognizeAsync($sbmp)) ([Windows.Media.Ocr.OcrResult]); $r.text = ($res.Lines | ForEach-Object { $_.Text }) -join "\`n" }
    $stream.Dispose()
  } catch { $r.ocrError = $_.Exception.Message }
  finally { if ($png) { Remove-Item -LiteralPath $png -ErrorAction SilentlyContinue } }
  $r.frame = $true
} elseif ($skip) { $r.skipped = 'rule' }
[IO.File]::WriteAllText(${q(out)}, (ConvertTo-Json $r -Compress), (New-Object System.Text.UTF8Encoding $false))`;
  try {
    await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script]);
    const j = JSON.parse(await readFile(out, "utf8")) as { idle: number; app: string; title: string; hash?: string; text?: string; frame?: boolean; skipped?: string };
    return { t: Date.now(), app: j.app ?? "", title: j.title ?? "", ...(j.idle >= idleSec ? { idle: true } : {}), ...(j.text ? { text: j.text } : {}), ...(j.frame ? { frame: "" } : {}), ...(j.hash ? { hash: j.hash } : {}), ...(j.skipped ? { skipped: j.skipped } : {}) };
  } finally {
    await rm(out, { force: true });
  }
}

/** Converts a JS regex source into a .NET-safe, case-insensitive pattern for PowerShell's -match. */
function dotnetPattern(apps: string[]): string {
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const names = ["1password", "bitwarden", "keepass", "keepassxc", "lastpass", "dashlane", "nordpass", "enpass", "keeper", "lockapp", "logonui", "consent", "credentialuibroker", ...apps.map((a) => a.replace(/\.exe$/i, ""))].filter(Boolean).map(esc);
  return `^(${names.join("|")})$|${PRIVATE_WINDOW.source}|(password|passcode|sign[ -]?in|log[ -]?in|2fa|two-factor|verification code|bank|payment|checkout|credit card|paypal|wallet|סיסמ|התחבר|כניסה לחשבון|תשלום|כרטיס אשראי|בנק)`;
}

const MEETING_PROMPT = `You get the transcript of a meeting recorded on the user's computer (their microphone and the call's audio, transcribed in pieces, so words may be cut or misheard). Answer with JSON only:
{"summary":"3-6 plain sentences: what the meeting was about and what was agreed","decisions":["each decision, one line"],"actions":[{"text":"a concrete follow-up, in the imperative","who":"who owns it, if said"}]}
Never invent names, numbers or decisions that are not in the transcript. Write in the language most of the meeting was in.`;

const SUMMARY_PROMPT = `You read a log of what was on a person's computer screen (app, window title, and the text on screen) and write their private journal. Answer with JSON only:
{"observations":[{"from":"HH:MM","to":"HH:MM","kind":"meeting|focus|communication|research|break|other","text":"one or two plain sentences about what they did"}],
 "actions":[{"text":"a concrete to-do the person was asked to do or promised, in the imperative","who":"who asked or who it is for"}],
 "entities":[{"name":"exact name","kind":"person|project|company|concept","note":"what this stretch says about it"}]}
Rules: 2-6 observations, merged by activity, in time order. Actions only when the screen clearly shows a request or promise (an email, chat or ticket); never invent. Entities: real names that appear, not apps. Never copy passwords, codes, card or account numbers. Write in the language most of the screen text is in.`;

/** Runs the journal: capture, storage, summaries, search. */
export class Journal {
  private settings: JournalSettings = { ...DEFAULTS };
  private timer?: NodeJS.Timeout;
  private summarizing = false;
  private lastHash = "";
  private lastSummary = 0;
  private state: { running: boolean; lastCapture?: number; error?: string; ocr?: boolean; last?: Pick<Capture, "app" | "title" | "skipped" | "idle"> } = { running: false };
  private entities: Entity[] = [];
  private loaded?: Promise<void>;

  /**
   * @param dir - The journal folder (only on this computer).
   * @param model - The model to write observations with, and whether it runs on this computer; undefined when there is none.
   * @param capture - Takes one capture (replaceable in tests).
   */
  constructor(
    private readonly dir: string,
    private readonly model: (modelId?: string) => { turn: ModelTurn; local: boolean; id: string } | undefined,
    private readonly capture?: (frame: string, s: JournalSettings) => Promise<Capture & { hash?: string }>,
  ) {}

  /** Loads the settings and starts capturing if it was on. */
  load(): Promise<void> {
    this.loaded ??= (async () => {
      try {
        this.settings = { ...DEFAULTS, ...(JSON.parse(await readFile(join(this.dir, "settings.json"), "utf8")) as Partial<JournalSettings>) };
      } catch {
        /* first time */
      }
      try {
        this.entities = JSON.parse(await readFile(join(this.dir, "entities.json"), "utf8")) as Entity[];
      } catch {
        this.entities = [];
      }
      this.schedule();
      void this.cleanup();
    })();
    return this.loaded;
  }

  /** @returns Settings and status. */
  async info() {
    await this.load();
    return { settings: this.settings, status: this.state, days: await this.days(), platform: process.platform };
  }

  /** @returns Days that have a journal, newest first. */
  async days(): Promise<string[]> {
    const all = await readdir(this.dir).catch(() => [] as string[]);
    return all.filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().reverse();
  }

  /**
   * Changes settings.
   *
   * @param patch - The fields to change.
   * @returns The settings.
   */
  async update(patch: Partial<JournalSettings>): Promise<JournalSettings> {
    await this.load();
    const n = (v: unknown, lo: number, hi: number, d: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
    this.settings = {
      ...this.settings,
      ...(typeof patch.enabled === "boolean" ? { enabled: patch.enabled } : {}),
      intervalSec: n(patch.intervalSec, 10, 600, this.settings.intervalSec),
      keepFramesDays: n(patch.keepFramesDays, 1, 365, this.settings.keepFramesDays),
      keepTextDays: n(patch.keepTextDays, 1, 3650, this.settings.keepTextDays),
      ...(Array.isArray(patch.excludeApps) ? { excludeApps: patch.excludeApps.map(String).filter(Boolean).slice(0, 100) } : {}),
      ...(typeof patch.allowCloud === "boolean" ? { allowCloud: patch.allowCloud } : {}),
      ...("modelId" in patch ? { modelId: patch.modelId || undefined } : {}),
      ...("pausedUntil" in patch ? { pausedUntil: patch.pausedUntil || undefined } : {}),
    };
    if (!this.settings.modelId) delete this.settings.modelId;
    if (!this.settings.pausedUntil) delete this.settings.pausedUntil;
    await mkdir(this.dir, { recursive: true });
    await writeFile(join(this.dir, "settings.json"), JSON.stringify(this.settings, null, 2));
    this.schedule();
    return this.settings;
  }

  private schedule() {
    clearTimeout(this.timer);
    this.state.running = this.settings.enabled;
    if (!this.settings.enabled) return;
    this.timer = setTimeout(() => void this.tick(), this.settings.intervalSec * 1000);
    this.timer.unref?.();
  }

  /** Takes one capture now (and a summary when due). */
  async tick(): Promise<void> {
    try {
      if (this.settings.enabled && !(this.settings.pausedUntil && this.settings.pausedUntil > Date.now())) await this.captureOnce();
      if (Date.now() - this.lastSummary > 15 * 60_000) {
        this.lastSummary = Date.now();
        void this.summarize(dayKey(Date.now())).catch(() => undefined);
      }
    } finally {
      this.schedule();
    }
  }

  private async captureOnce() {
    const now = Date.now();
    const day = dayKey(now);
    const folder = join(this.dir, day);
    await mkdir(join(folder, "frames"), { recursive: true });
    const stamp = new Date(now).toTimeString().slice(0, 8).replace(/:/g, "");
    const taken = new Set(await readdir(join(folder, "frames")).catch(() => [] as string[]));
    let name = `${stamp}.jpg`;
    for (let k = 2; taken.has(name); k++) name = `${stamp}-${k}.jpg`;
    const framePath = join(folder, "frames", name);
    let cap: Capture & { hash?: string };
    try {
      cap = await (this.capture ?? defaultCapture)(framePath, this.settings);
      this.state.error = undefined;
    } catch (e) {
      this.state.error = (e as Error).message;
      return;
    }
    // A second check in Node, in case the window changed or the rule missed.
    const why = cap.skipped ? cap.skipped : skipReason(cap.app, cap.title, this.settings.excludeApps);
    if (why) {
      await rm(framePath, { force: true });
      cap = { t: cap.t, app: cap.app, title: "", skipped: why };
    } else if (cap.frame !== undefined) {
      if (cap.hash && cap.hash === this.lastHash) {
        await rm(framePath, { force: true });
        delete cap.frame; // same screen as before: keep the time, not another picture
      } else cap.frame = name;
      this.lastHash = cap.hash ?? "";
    }
    if (cap.text) cap.text = cap.text.slice(0, 6000);
    this.state.ocr = cap.text !== undefined || this.state.ocr;
    this.state.lastCapture = cap.t;
    this.state.last = { app: cap.app, title: cap.title, ...(cap.skipped ? { skipped: cap.skipped } : {}), ...(cap.idle ? { idle: true } : {}) };
    const { hash: _h, ...line } = cap;
    await appendFile(join(folder, "captures.jsonl"), JSON.stringify(line) + "\n");
  }

  /**
   * @param day - `YYYY-MM-DD`.
   * @returns The day's captures.
   */
  async captures(day: string): Promise<Capture[]> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return [];
    const raw = await readFile(join(this.dir, day, "captures.jsonl"), "utf8").catch(() => "");
    return raw
      .split("\n")
      .filter(Boolean)
      .flatMap((l) => {
        try {
          return [JSON.parse(l) as Capture];
        } catch {
          return [];
        }
      });
  }

  /** @returns A day's model output. */
  async insights(day: string): Promise<DayInsights> {
    try {
      return JSON.parse(await readFile(join(this.dir, day, "insights.json"), "utf8")) as DayInsights;
    } catch {
      return { observations: [], actions: [], summarizedTo: 0 };
    }
  }

  private async saveInsights(day: string, v: DayInsights) {
    await mkdir(join(this.dir, day), { recursive: true });
    await writeFile(join(this.dir, day, "insights.json"), JSON.stringify(v, null, 2));
  }

  /** @returns Everything for the Day page. */
  async day(day: string) {
    await this.load();
    const caps = await this.captures(day);
    return {
      day,
      captures: caps.map((c) => ({ ...c, ...(c.text ? { text: c.text.slice(0, 400) } : {}) })),
      meetings: await this.meetings(day),
      insights: await this.insights(day),
      stats: dayStats(caps, this.settings.intervalSec),
      entities: this.entities.filter((e) => !e.hidden && e.days.includes(day)).map((e) => ({ id: e.id, name: e.name, kind: e.kind })),
    };
  }

  /** @returns Stats for several days (Reflect: the week). */
  async week(endDay: string) {
    const out: Array<{ day: string; stats: DayStats }> = [];
    const end = new Date(`${endDay}T12:00:00`);
    for (let i = 6; i >= 0; i--) {
      const d = dayKey(end.getTime() - i * 86_400_000);
      out.push({ day: d, stats: dayStats(await this.captures(d), this.settings.intervalSec) });
    }
    return out;
  }

  /**
   * Writes observations, actions and entities for the part of a day not summarized yet.
   *
   * @param day - `YYYY-MM-DD`.
   * @param force - Redo the whole day.
   * @returns The day's insights.
   */
  async summarize(day: string, force = false): Promise<DayInsights> {
    if (this.summarizing) return this.insights(day);
    this.summarizing = true;
    try {
      const prev = force ? { observations: [], actions: (await this.insights(day)).actions, summarizedTo: 0 } : await this.insights(day);
      const caps = (await this.captures(day)).filter((c) => c.t > prev.summarizedTo && !c.idle && !c.skipped);
      if (caps.length < 3) return prev;
      const m = this.model(this.settings.modelId);
      if (!m) return { ...prev, error: "Choose a chat model so the journal can write observations." };
      if (!m.local && !this.settings.allowCloud) return { ...prev, error: `${m.id} runs in the cloud. Choose a model on this computer, or allow cloud models for the journal.` };
      // A compact log: one line per change of window, with new screen text only.
      const lines: string[] = [];
      let last = "";
      const seen = new Set<string>();
      for (const c of caps) {
        const hhmm = new Date(c.t).toTimeString().slice(0, 5);
        const head = `${c.app} — ${c.title}`;
        const fresh = (c.text ?? "")
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => l.length > 3 && !seen.has(l) && (seen.add(l), true))
          .join(" | ")
          .slice(0, 500);
        if (head === last && !fresh) continue;
        lines.push(`${hhmm} ${head}${fresh ? `\n  ${fresh}` : ""}`);
        last = head;
      }
      const log = lines.join("\n").slice(-24_000);
      let text = "";
      try {
        const r = await m.turn({ messages: [{ role: "system", content: SUMMARY_PROMPT }, { role: "user", content: log }], tools: [] }, AbortSignal.timeout(300_000), () => undefined);
        text = r.text;
      } catch (e) {
        const v = { ...prev, error: (e as Error).message };
        await this.saveInsights(day, v);
        return v;
      }
      const found = parseInsights(text);
      const at = (hhmm: string | undefined, fallback: number) => {
        const mm = /^(\d{1,2}):(\d{2})/.exec(hhmm ?? "");
        if (!mm) return fallback;
        const d = new Date(fallback);
        d.setHours(Number(mm[1]), Number(mm[2]), 0, 0);
        return d.getTime();
      };
      const t0 = caps[0]!.t;
      const t1 = caps.at(-1)!.t;
      const open = new Set(prev.actions.map((a) => a.text.toLowerCase()));
      const next: DayInsights = {
        observations: [...prev.observations, ...found.observations.map((o) => ({ id: randomUUID(), t0: at(o.from, t0), t1: at(o.to, t1), text: o.text.slice(0, 600), ...(o.kind ? { kind: o.kind } : {}) }))],
        actions: [...prev.actions, ...found.actions.filter((a) => !open.has(a.text.toLowerCase())).map((a) => ({ id: randomUUID(), t: t1, text: a.text.slice(0, 300), ...(a.who ? { who: a.who.slice(0, 80) } : {}), state: "open" as const }))],
        summarizedTo: t1,
      };
      await this.saveInsights(day, next);
      await this.addEntities(day, found.entities, t1);
      return next;
    } finally {
      this.summarizing = false;
    }
  }

  private async addEntities(day: string, found: Array<{ name: string; kind?: string; note?: string }>, t: number) {
    const kinds = new Set(["person", "project", "company", "concept"]);
    for (const f of found.slice(0, 30)) {
      const name = f.name.trim().slice(0, 80);
      const key = name.toLowerCase();
      const hit = this.entities.find((e) => e.name.toLowerCase() === key || e.aliases.some((a) => a.toLowerCase() === key));
      if (hit) {
        if (!hit.days.includes(day)) hit.days.push(day);
        hit.lastSeen = t;
        if (f.note) hit.summary = f.note.slice(0, 600);
      } else {
        this.entities.push({ id: randomUUID(), name, kind: (kinds.has(f.kind ?? "") ? f.kind : "concept") as Entity["kind"], ...(f.note ? { summary: f.note.slice(0, 600) } : {}), aliases: [], days: [day], lastSeen: t });
      }
    }
    await this.saveEntities();
  }

  private async saveEntities() {
    await mkdir(this.dir, { recursive: true });
    await writeFile(join(this.dir, "entities.json"), JSON.stringify(this.entities, null, 2));
  }

  /** @returns All entities, most recent first. */
  async listEntities(): Promise<Entity[]> {
    await this.load();
    return [...this.entities].sort((a, b) => b.lastSeen - a.lastSeen);
  }

  /**
   * Changes an entity: rename, kind, hide, parent, or merge others into it.
   *
   * @param id - The entity.
   * @param patch - What to change; `merge` lists ids folded into this one.
   * @returns The entity.
   */
  async editEntity(id: string, patch: { name?: string; kind?: Entity["kind"]; hidden?: boolean; parent?: string | null; merge?: string[] }): Promise<Entity | undefined> {
    await this.load();
    const e = this.entities.find((x) => x.id === id);
    if (!e) return undefined;
    if (patch.name?.trim()) e.name = patch.name.trim().slice(0, 80);
    if (patch.kind) e.kind = patch.kind;
    if (typeof patch.hidden === "boolean") e.hidden = patch.hidden;
    if (patch.parent === null) delete e.parent;
    else if (patch.parent && patch.parent !== id) e.parent = patch.parent;
    for (const other of patch.merge ?? []) {
      const o = this.entities.find((x) => x.id === other && x.id !== id);
      if (!o) continue;
      e.aliases = [...new Set([...e.aliases, o.name, ...o.aliases])];
      e.days = [...new Set([...e.days, ...o.days])].sort();
      e.lastSeen = Math.max(e.lastSeen, o.lastSeen);
      this.entities = this.entities.filter((x) => x.id !== other);
      for (const x of this.entities) if (x.parent === other) x.parent = id;
    }
    await this.saveEntities();
    return e;
  }

  /** Marks an action done, dismissed or open again. */
  async setAction(day: string, id: string, state: ActionItem["state"]): Promise<DayInsights> {
    const v = await this.insights(day);
    const a = v.actions.find((x) => x.id === id);
    if (a) a.state = state;
    await this.saveInsights(day, v);
    return v;
  }

  /** @returns Open actions from the last weeks, newest first. */
  async openActions(): Promise<Array<ActionItem & { day: string }>> {
    const out: Array<ActionItem & { day: string }> = [];
    for (const d of (await this.days()).slice(0, 30)) for (const a of (await this.insights(d)).actions) if (a.state === "open") out.push({ ...a, day: d });
    return out.sort((a, b) => b.t - a.t);
  }

  /**
   * Searches screen text, window titles, observations and entities.
   *
   * @param q - Words to find (all must appear).
   * @param limit - Most results.
   * @returns Matches, newest first.
   */
  async search(q: string, limit = 60): Promise<Array<{ kind: "screen" | "observation" | "entity" | "action" | "meeting"; day: string; t: number; title: string; snippet: string; frame?: string }>> {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return [];
    const hit = (s: string) => {
      const l = s.toLowerCase();
      return words.every((w) => l.includes(w));
    };
    const snip = (s: string) => {
      const l = s.toLowerCase();
      const i = Math.max(0, l.indexOf(words[0]!) - 60);
      return (i ? "…" : "") + s.slice(i, i + 200).replace(/\s+/g, " ");
    };
    const out: Awaited<ReturnType<Journal["search"]>> = [];
    for (const e of this.entities) if (!e.hidden && hit(`${e.name} ${e.aliases.join(" ")} ${e.summary ?? ""}`)) out.push({ kind: "entity", day: e.days.at(-1) ?? "", t: e.lastSeen, title: e.name, snippet: e.summary ?? "" });
    for (const day of await this.days()) {
      const ins = await this.insights(day);
      for (const o of ins.observations) if (hit(o.text)) out.push({ kind: "observation", day, t: o.t0, title: o.kind ?? "", snippet: snip(o.text) });
      for (const a of ins.actions) if (hit(a.text)) out.push({ kind: "action", day, t: a.t, title: a.who ?? "", snippet: a.text });
      for (const m of await this.meetings(day)) {
        const seg = m.segments.find((x) => hit(x.text));
        if (seg || hit(`${m.title} ${m.summary ?? ""}`)) out.push({ kind: "meeting", day, t: seg?.t ?? m.t0, title: m.title, snippet: snip(seg?.text ?? m.summary ?? m.title) });
      }
      let lastKey = "";
      for (const c of await this.captures(day)) {
        const body = `${c.title}\n${c.text ?? ""}`;
        if (c.skipped || !hit(body)) continue;
        const key = `${c.app}|${c.title}`;
        if (key === lastKey) continue; // one result per stretch in a window
        lastKey = key;
        out.push({ kind: "screen", day, t: c.t, title: `${c.app} — ${c.title}`, snippet: snip(c.text && hit(c.text) ? c.text : c.title), ...(c.frame ? { frame: c.frame } : {}) });
      }
      if (out.length > limit * 3) break;
    }
    return out.sort((a, b) => b.t - a.t).slice(0, limit);
  }

  /**
   * @param day - `YYYY-MM-DD`.
   * @param file - The frame's file name.
   * @returns The picture, if it is still kept.
   */
  async frame(day: string, file: string): Promise<Buffer | undefined> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !/^\d{6}(-\d+)?\.jpg$/.test(file)) return undefined;
    return readFile(join(this.dir, day, "frames", file)).catch(() => undefined);
  }

  /** Deletes a whole day. */
  async forgetDay(day: string): Promise<void> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return;
    await rm(join(this.dir, day), { recursive: true, force: true });
    for (const e of this.entities) e.days = e.days.filter((d) => d !== day);
    this.entities = this.entities.filter((e) => e.days.length);
    await this.saveEntities();
  }

  /** Deletes the last few minutes (pictures and text). */
  async forgetRecent(minutes: number): Promise<number> {
    const day = dayKey(Date.now());
    const from = Date.now() - minutes * 60_000;
    const caps = await this.captures(day);
    const drop = caps.filter((c) => c.t >= from);
    for (const c of drop) if (c.frame) await rm(join(this.dir, day, "frames", c.frame), { force: true });
    await writeFile(join(this.dir, day, "captures.jsonl"), caps.filter((c) => c.t < from).map((c) => JSON.stringify(c)).join("\n") + (caps.length > drop.length ? "\n" : ""));
    return drop.length;
  }

  /** Deletes old pictures and old text, as the settings say. */
  async cleanup(now = Date.now()): Promise<void> {
    for (const day of await this.days()) {
      const age = (now - new Date(`${day}T23:59:59`).getTime()) / 86_400_000;
      if (age > this.settings.keepTextDays) await rm(join(this.dir, day), { recursive: true, force: true });
      else if (age > this.settings.keepFramesDays) await rm(join(this.dir, day, "frames"), { recursive: true, force: true });
    }
  }

  // ---------- meetings: recorded and transcribed in the app, written up by the model ----------

  private meetingPath(day: string, id: string) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !/^[a-f0-9-]{36}$/.test(id)) throw new Error("No such meeting.");
    return join(this.dir, day, "meetings", `${id}.json`);
  }

  private async saveMeeting(day: string, m: Meeting) {
    await mkdir(join(this.dir, day, "meetings"), { recursive: true });
    await writeFile(this.meetingPath(day, m.id), JSON.stringify(m, null, 2));
  }

  /** Reads one meeting. */
  async meeting(day: string, id: string): Promise<Meeting | undefined> {
    try {
      return JSON.parse(await readFile(this.meetingPath(day, id), "utf8")) as Meeting;
    } catch {
      return undefined;
    }
  }

  /** @returns A day's recorded meetings, in order. */
  async meetings(day: string): Promise<Meeting[]> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return [];
    const files = await readdir(join(this.dir, day, "meetings")).catch(() => [] as string[]);
    const out: Meeting[] = [];
    for (const f of files) {
      const m = await this.meeting(day, f.replace(/\.json$/, ""));
      if (m) out.push(m);
    }
    return out.sort((a, b) => a.t0 - b.t0);
  }

  /**
   * Starts a meeting record.
   *
   * @param title - What to call it (usually the call window's title).
   * @returns The day and the meeting.
   */
  async startMeeting(title: string): Promise<{ day: string; meeting: Meeting }> {
    const t0 = Date.now();
    const day = dayKey(t0);
    const m: Meeting = { id: randomUUID(), title: title.trim().slice(0, 120) || "Meeting", t0, segments: [] };
    await this.saveMeeting(day, m);
    return { day, meeting: m };
  }

  /** Adds what was said in one piece of the recording. */
  async addSegment(day: string, id: string, t: number, text: string): Promise<Meeting> {
    const m = await this.meeting(day, id);
    if (!m) throw new Error("No such meeting.");
    const clean = text.trim();
    if (clean) m.segments.push({ t: Number.isFinite(t) ? t : Date.now(), text: clean.slice(0, 8000) });
    m.segments.sort((a, b) => a.t - b.t);
    await this.saveMeeting(day, m);
    return m;
  }

  /**
   * Ends a meeting and writes it up: summary, decisions, and action items
   * (added to the day's actions).
   *
   * @param day - The meeting's day.
   * @param id - The meeting.
   * @returns The meeting.
   */
  async finishMeeting(day: string, id: string): Promise<Meeting> {
    const m = await this.meeting(day, id);
    if (!m) throw new Error("No such meeting.");
    m.t1 ??= Date.now();
    delete m.error;
    const transcript = m.segments.map((x) => `[${new Date(x.t).toTimeString().slice(0, 5)}] ${x.text}`).join("\n");
    if (transcript.length < 40) {
      m.error = "Too little was said to write it up.";
      await this.saveMeeting(day, m);
      return m;
    }
    const model = this.model(this.settings.modelId);
    if (!model) m.error = "Choose a chat model so the meeting can be written up.";
    else if (!model.local && !this.settings.allowCloud) m.error = `${model.id} runs in the cloud. Choose a model on this computer, or allow cloud models in My day's settings.`;
    else {
      try {
        const r = await model.turn({ messages: [{ role: "system", content: MEETING_PROMPT }, { role: "user", content: `Meeting: ${m.title}\n\n${transcript.slice(-60_000)}` }], tools: [] }, AbortSignal.timeout(600_000), () => undefined);
        const j = parseMeeting(r.text);
        m.summary = j.summary;
        m.decisions = j.decisions;
        if (j.actions.length) {
          const ins = await this.insights(day);
          const added = j.actions.map((a) => ({ id: randomUUID(), t: m.t1!, text: a.text.slice(0, 300), ...(a.who ? { who: a.who.slice(0, 80) } : {}), state: "open" as const }));
          ins.actions.push(...added);
          ins.observations.push({ id: randomUUID(), t0: m.t0, t1: m.t1!, kind: "meeting", text: `${m.title}: ${j.summary}`.slice(0, 600) });
          await this.saveInsights(day, ins);
          m.actionIds = added.map((a) => a.id);
        }
      } catch (e) {
        m.error = (e as Error).message;
      }
    }
    await this.saveMeeting(day, m);
    return m;
  }

  /** Deletes a meeting record. */
  async deleteMeeting(day: string, id: string): Promise<void> {
    await rm(this.meetingPath(day, id), { force: true });
  }

  /** Stops capturing. */
  close(): void {
    clearTimeout(this.timer);
  }
}

/** Takes one capture with the platform's tools. */
async function defaultCapture(frame: string, s: JournalSettings): Promise<Capture & { hash?: string }> {
  if (process.platform === "win32") return windowsCapture(frame, 120, dotnetPattern(s.excludeApps));
  // macOS and Linux: picture and window title; screen text where tesseract is installed.
  const be = screenBackend();
  const fg = await be.foreground();
  if (skipReason(fg.app, fg.title, s.excludeApps)) return { t: Date.now(), app: fg.app, title: fg.title, skipped: "rule" };
  const shot = await be.screenshot(1280);
  const png = frame.replace(/\.jpg$/, ".png");
  await writeFile(png, shot.png);
  let text: string | undefined;
  try {
    text = (await run("tesseract", [png, "-", "-l", "eng+heb"], 60_000)).trim();
  } catch {
    /* no OCR here */
  }
  // Keep the picture as PNG under the .jpg name the index expects; browsers sniff the type.
  await writeFile(frame, shot.png);
  await rm(png, { force: true });
  return { t: Date.now(), app: fg.app, title: fg.title, frame: "", hash: createHash("sha1").update(shot.png).digest("hex"), ...(text ? { text } : {}) };
}

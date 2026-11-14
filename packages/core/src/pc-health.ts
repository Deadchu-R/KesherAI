/**
 * PC Health, with AI (docs/VISION.md): what the computer is short of, in numbers, then a short list of what to do.
 * Like Copilot's PC insights and Microsoft PC Manager's health check (docs/RESEARCH_LOG.md): it only reads. The
 * list is made from fixed rules (so it works with no model), and the chat's model can rewrite it in plain words.
 * Nothing is deleted here: the steps say where the user does it.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, stat, statfs } from "node:fs/promises";
import { homedir, platform, tmpdir, totalmem, freemem, uptime } from "node:os";
import { join } from "node:path";

/** One drive's space. */
export interface DriveSpace {
  name: string;
  freeBytes: number;
  totalBytes: number;
}

/** A folder's size (counting stops at a limit, then `partial`). */
export interface FolderSize {
  name: string;
  path: string;
  bytes: number;
  partial?: boolean;
}

/** One reading of the computer. */
export interface HealthReading {
  at: string;
  platform: string;
  drives: DriveSpace[];
  /** KesherAI's own folders, largest first. */
  kesher: FolderSize[];
  /** The temporary files folder. */
  temp?: FolderSize;
  /** Windows: a previous Windows installation is still kept (often tens of GB). */
  windowsOld: boolean;
  /** Windows: an update waits for a restart. */
  restartPending: boolean;
  /** Windows: programs that start with the computer (names only). */
  startup: string[];
  ram: { usedBytes: number; totalBytes: number };
  cpu?: { percent: number; temp?: number };
  gpus: Array<{ name: string; temp: number; memUsedBytes: number; memTotalBytes: number }>;
  uptimeHours: number;
}

/** One thing worth doing. */
export interface HealthItem {
  level: "ok" | "warn" | "bad";
  /** What is wrong, short. */
  title: string;
  /** What to do about it. */
  fix: string;
}

const GB = 1024 ** 3;

/** Runs a read-only command; its output, or "" when it fails. */
function run(file: string, args: string[], timeoutMs = 8000): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, windowsHide: true }, (err, stdout) => resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, out: String(stdout ?? "") }));
  });
}

/**
 * A folder's size, counting files until `maxEntries` or `maxMs` (then `partial`). Links are not followed.
 *
 * @param path - The folder.
 */
export async function folderSize(name: string, path: string, maxEntries = 60_000, maxMs = 4000): Promise<FolderSize> {
  const started = Date.now();
  let bytes = 0;
  let seen = 0;
  const stack = [path];
  while (stack.length) {
    if (seen >= maxEntries || Date.now() - started > maxMs) return { name, path, bytes, partial: true };
    const dir = stack.pop()!;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      seen++;
      const p = join(dir, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) bytes += await stat(p).then((s) => s.size, () => 0);
    }
  }
  return { name, path, bytes };
}

/** The drives (Windows: every letter that answers; elsewhere the root and the home folder). */
async function drives(): Promise<DriveSpace[]> {
  const roots = platform() === "win32" ? "CDEFGHIJKLMNOPQRSTUVWXYZ".split("").map((l) => `${l}:\\`).filter((r) => existsSync(r)) : [...new Set(["/", homedir()])];
  const out: DriveSpace[] = [];
  for (const r of roots) {
    try {
      const s = await statfs(r);
      const d = { name: platform() === "win32" ? r.slice(0, 2) : r, freeBytes: s.bavail * s.bsize, totalBytes: s.blocks * s.bsize };
      if (!out.some((x) => x.totalBytes === d.totalBytes && x.freeBytes === d.freeBytes)) out.push(d);
    } catch {
      /* not ready (an empty card reader): skipped */
    }
  }
  return out;
}

/** Windows' startup programs (current user and all users), names only. */
async function startupApps(): Promise<string[]> {
  if (platform() !== "win32") return [];
  const names: string[] = [];
  for (const key of ["HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run", "HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Run"]) {
    const { out } = await run("reg", ["query", key]);
    for (const line of out.split(/\r?\n/)) {
      const m = /^\s{4}(.+?)\s{4}REG_\w+\s{4}/.exec(line);
      if (m && !names.includes(m[1]!)) names.push(m[1]!);
    }
  }
  return names.slice(0, 40);
}

/**
 * Reads the computer: drives, KesherAI's folders, temporary files, memory, processor and cards (from the guard,
 * which already reads them), and on Windows the old Windows folder, a waiting restart and the startup programs.
 *
 * @param o.dataRoot - KesherAI's data folder.
 * @param o.extra - More of KesherAI's folders (self-work copies).
 * @param o.guard - The guard's last readings.
 */
export async function readHealth(o: {
  dataRoot: string;
  extra?: Array<{ name: string; path: string }>;
  guard?: { system: { ramUsed: number; ramTotal: number; cpu: number; cpuTemp?: number }; cards: Array<{ name: string; temp: number; memUsed: number; memTotal: number }> };
}): Promise<HealthReading> {
  const win = platform() === "win32";
  const top = await readdir(o.dataRoot, { withFileTypes: true }).catch(() => []);
  const folders = [...top.filter((e) => e.isDirectory()).map((e) => ({ name: e.name, path: join(o.dataRoot, e.name) })), ...(o.extra ?? []).filter((f) => existsSync(f.path))];
  const [d, kesher, temp, startup, restart] = await Promise.all([
    drives(),
    Promise.all(folders.map((f) => folderSize(f.name, f.path))),
    folderSize("temp", tmpdir(), 40_000, 3000),
    startupApps(),
    win ? run("reg", ["query", "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\WindowsUpdate\\Auto Update\\RebootRequired"]) : Promise.resolve({ code: 1, out: "" }),
  ]);
  const sys = o.guard?.system;
  return {
    at: new Date().toISOString(),
    platform: platform(),
    drives: d,
    kesher: kesher.filter((f) => f.bytes > 50 * 1024 ** 2).sort((a, b) => b.bytes - a.bytes).slice(0, 12),
    temp,
    windowsOld: win && existsSync("C:\\Windows.old"),
    restartPending: win && restart.code === 0,
    startup,
    ram: sys?.ramTotal ? { usedBytes: sys.ramUsed, totalBytes: sys.ramTotal } : { usedBytes: totalmem() - freemem(), totalBytes: totalmem() },
    ...(sys ? { cpu: { percent: Math.round(sys.cpu), ...(sys.cpuTemp !== undefined ? { temp: sys.cpuTemp } : {}) } } : {}),
    gpus: (o.guard?.cards ?? []).map((c) => ({ name: c.name, temp: c.temp, memUsedBytes: c.memUsed, memTotalBytes: c.memTotal })),
    uptimeHours: Math.round(uptime() / 3600),
  };
}

const gb = (b: number) => (b >= 10 * GB ? Math.round(b / GB) : Math.round((b / GB) * 10) / 10);

/**
 * What to do, from fixed rules (works with no model): full drives, the old Windows folder, a waiting restart, big
 * temporary files, KesherAI's own big folders, hot cards, memory, many startup programs, days without a restart.
 *
 * @param r - A reading.
 * @param he - In Hebrew.
 */
export function healthItems(r: HealthReading, he = false): HealthItem[] {
  const L = (h: string, e: string) => (he ? h : e);
  // A number with its unit stays in order inside Hebrew text ("15 GB", not "GB 15").
  const n = (t: string) => (he ? `\u2066${t}\u2069` : t);
  const out: HealthItem[] = [];
  for (const d of r.drives) {
    const freePct = d.totalBytes ? d.freeBytes / d.totalBytes : 1;
    if (d.freeBytes < 5 * GB || freePct < 0.05)
      out.push({ level: "bad", title: L(`בכונן ${n(d.name)} נשארו רק ${n(`${gb(d.freeBytes)} GB`)}`, `Only ${gb(d.freeBytes)} GB left on ${d.name}`), fix: L("הגדרות ← מערכת ← אחסון ← קבצים זמניים; ומה שגדול למטה.", "Settings → System → Storage → Temporary files; and the big items below.") });
    else if (d.freeBytes < 20 * GB || freePct < 0.1)
      out.push({ level: "warn", title: L(`בכונן ${n(d.name)} נשארו ${n(`${gb(d.freeBytes)} GB`)}`, `${gb(d.freeBytes)} GB left on ${d.name}`), fix: L("כדאי לפנות מקום לפני הורדת מודל גדול.", "Worth clearing some space before downloading a big model.") });
  }
  if (r.windowsOld) out.push({ level: "warn", title: L("Windows.old עדיין קיים (בדרך כלל עשרות GB)", "Windows.old is still there (usually tens of GB)"), fix: L("הגדרות ← מערכת ← אחסון ← קבצים זמניים ← \"התקנות קודמות של Windows\".", "Settings → System → Storage → Temporary files → \"Previous Windows installation(s)\".") });
  if (r.restartPending) out.push({ level: "warn", title: L("עדכון של Windows מחכה להפעלה מחדש", "A Windows update waits for a restart"), fix: L("הפעילו מחדש כשנוח (שמרו עבודה קודם).", "Restart when convenient (save your work first).") });
  if (r.temp && r.temp.bytes > 5 * GB) out.push({ level: "warn", title: L(`${n(`${gb(r.temp.bytes)} GB${r.temp.partial ? "+" : ""}`)} בקבצים זמניים`, `${gb(r.temp.bytes)} GB${r.temp.partial ? "+" : ""} of temporary files`), fix: L("הגדרות ← מערכת ← אחסון ← קבצים זמניים.", "Settings → System → Storage → Temporary files.") });
  for (const f of r.kesher.filter((x) => x.bytes > 30 * GB).slice(0, 3))
    out.push({ level: "warn", title: L(`התיקייה "${f.name}" של KesherAI תופסת ${n(`${gb(f.bytes)} GB`)}`, `KesherAI's "${f.name}" folder takes ${gb(f.bytes)} GB`), fix: f.name === "models" ? L("בעמוד המודלים: מחקו מודלים שלא משתמשים בהם.", "On the Models page: delete models you do not use.") : L("בדקו מה בה; KesherAI לא מוחק בלי לשאול.", "Check what is in it; KesherAI never deletes without asking.") });
  for (const g of r.gpus) {
    if (g.temp >= 85) out.push({ level: "bad", title: L(`הכרטיס ${n(g.name)} חם: ${n(`${g.temp}°C`)}`, `${g.name} is hot: ${g.temp}°C`), fix: L("בדקו זרימת אוויר ואבק; בהגדרות KesherAI אפשר להוריד את סף ההמתנה לקירור.", "Check airflow and dust; in KesherAI's settings you can lower the cool-down limit.") });
    else if (g.memTotalBytes && g.memUsedBytes / g.memTotalBytes > 0.95) out.push({ level: "warn", title: L(`זיכרון הכרטיס ${g.name} כמעט מלא`, `${g.name}'s memory is almost full`), fix: L("סגרו משחקים או מודלים טעונים שלא בשימוש.", "Close games or loaded models you are not using.") });
  }
  if (r.ram.totalBytes && r.ram.usedBytes / r.ram.totalBytes > 0.9) out.push({ level: "warn", title: L(`הזיכרון (RAM) ב-${Math.round((r.ram.usedBytes / r.ram.totalBytes) * 100)}%`, `Memory (RAM) at ${Math.round((r.ram.usedBytes / r.ram.totalBytes) * 100)}%`), fix: L("סגרו תוכנות כבדות; מנהל המשימות מראה מה תופס.", "Close heavy programs; Task Manager shows what takes it.") });
  if (r.cpu?.temp !== undefined && r.cpu.temp >= 90) out.push({ level: "bad", title: L(`המעבד חם: ${n(`${r.cpu.temp}°C`)}`, `The processor is hot: ${r.cpu.temp}°C`), fix: L("בדקו קירור ואבק.", "Check cooling and dust.") });
  if (r.startup.length > 15) out.push({ level: "warn", title: L(`${r.startup.length} תוכנות עולות עם המחשב`, `${r.startup.length} programs start with the computer`), fix: L("מנהל המשימות ← אפליקציות הפעלה: כבו את מה שלא צריך.", "Task Manager → Startup apps: turn off what you do not need.") });
  if (r.uptimeHours > 24 * 14) out.push({ level: "warn", title: L(`המחשב לא הופעל מחדש ${Math.round(r.uptimeHours / 24)} ימים`, `No restart for ${Math.round(r.uptimeHours / 24)} days`), fix: L("הפעלה מחדש מפנה זיכרון ומסיימת עדכונים.", "A restart frees memory and finishes updates.") });
  if (!out.length) out.push({ level: "ok", title: L("הכול נראה תקין", "Everything looks fine"), fix: L("אין מה לעשות כרגע.", "Nothing to do right now.") });
  return out;
}

/** The model's instructions: rewrite the reading and the rules' list as a short plain-language list. */
export function healthPrompt(r: HealthReading, items: HealthItem[], he: boolean): string {
  return [
    `You look after the user's computer. Below is a reading (numbers) and a list made by fixed rules. Write a short list of what to do, most important first, in ${he ? "Hebrew" : "English"}: at most 6 items, one line each, plain words, with where to click. Keep the rules' numbers exactly. Add an item only if the numbers show it. Never suggest deleting files you cannot see, registry edits, or third-party "cleaner" programs. If all is fine, say so in one line.`,
    "",
    "Reading:",
    JSON.stringify({ ...r, drives: r.drives.map((d) => ({ name: d.name, freeGB: gb(d.freeBytes), totalGB: gb(d.totalBytes) })), kesher: r.kesher.map((f) => ({ name: f.name, GB: gb(f.bytes) })), temp: r.temp ? gb(r.temp.bytes) : undefined, ram: { usedGB: gb(r.ram.usedBytes), totalGB: gb(r.ram.totalBytes) }, gpus: r.gpus.map((g) => ({ name: g.name, temp: g.temp, memUsedGB: gb(g.memUsedBytes), memTotalGB: gb(g.memTotalBytes) })) }),
    "",
    "Rules' list:",
    ...items.map((i) => `- [${i.level}] ${i.title}: ${i.fix}`),
  ].join("\n");
}

/**
 * The daily check's decision (VISION: "a daily check sends a notification only when something needs attention"):
 * a note when there is something bad, or a warning not in the last note; at most once a day, and a bad thing already
 * told is told again only after three days.
 *
 * @param items - healthItems() of a fresh reading.
 * @param last - The last note sent: when, and the titles it named.
 * @returns The note to send (title, body, the titles to remember), or undefined.
 */
export function healthDigest(items: HealthItem[], last: { at: number; titles: string[] } | undefined, now = Date.now()): { title: string; body: string; titles: string[] } | undefined {
  const need = items.filter((i) => i.level !== "ok");
  if (!need.length) return undefined;
  if (last && now - last.at < 24 * 3_600_000) return undefined;
  const fresh = need.filter((i) => !last?.titles.includes(i.title));
  const badAgain = need.some((i) => i.level === "bad") && (!last || now - last.at >= 3 * 24 * 3_600_000);
  if (!fresh.length && !badAgain) return undefined;
  const bad = need.filter((i) => i.level === "bad").length;
  const shown = [...need].sort((a, b) => (a.level === b.level ? 0 : a.level === "bad" ? -1 : 1)).slice(0, 4);
  return {
    title: bad ? `PC Health: ${bad} thing${bad === 1 ? "" : "s"} to fix` : `PC Health: ${need.length} thing${need.length === 1 ? "" : "s"} worth a look`,
    body: shown.map((i) => `• ${i.title}`).join("\n") + (need.length > shown.length ? `\n…and ${need.length - shown.length} more` : ""),
    titles: need.map((i) => i.title),
  };
}

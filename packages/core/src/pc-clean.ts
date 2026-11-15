/**
 * Performance boost for the computer (PC health): caches and temporary files that are safe to delete, like Android's
 * cleaner and Windows' Storage Sense. Each place is measured first; only what the person ticks is cleaned, files in
 * use are skipped, and temporary files newer than a day are left (a program may still need them). Nothing outside
 * these fixed places is touched.
 */
import { execFile } from "node:child_process";
import { readdir, rm, rmdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** One place that can be cleaned. */
export interface CleanSpot {
  id: string;
  he: string;
  en: string;
  /** Why it is safe, in a few words. */
  noteHe: string;
  noteEn: string;
  /** Folders whose contents are deleted (the folders themselves stay). */
  dirs: string[];
  /** Only files older than this many hours. */
  olderThanHours?: number;
  /** Programs that must be closed first (their cache is in use while they run). */
  closeFirst?: string[];
}

/**
 * The places this computer has, by system.
 *
 * @param env - Environment variables (for tests).
 * @param platform - The system.
 */
export function cleanSpots(env: NodeJS.ProcessEnv = process.env, platform = process.platform): CleanSpot[] {
  if (platform !== "win32") {
    const home = env.HOME ?? homedir();
    return [
      { id: "cache", he: "קאש של תוכנות", en: "Program caches", noteHe: "תוכנות בונות אותו מחדש לבד", noteEn: "Programs build it again by themselves", dirs: [join(home, ".cache")], olderThanHours: 24 },
      { id: "thumbs", he: "תמונות ממוזערות", en: "Thumbnails", noteHe: "נוצרות מחדש כשפותחים תיקייה", noteEn: "Made again when a folder opens", dirs: [join(home, ".cache", "thumbnails")] },
    ];
  }
  const local = env.LOCALAPPDATA ?? join(env.USERPROFILE ?? homedir(), "AppData", "Local");
  const temp = env.TEMP ?? join(local, "Temp");
  const chromeLike = (base: string) => [join(base, "Default", "Cache"), join(base, "Default", "Code Cache"), join(base, "Default", "GPUCache"), join(base, "ShaderCache"), join(base, "GrShaderCache")];
  return [
    { id: "temp", he: "קבצים זמניים", en: "Temporary files", noteHe: "קבצים שתוכנות השאירו; רק מעל יום", noteEn: "Left by programs; only older than a day", dirs: [temp], olderThanHours: 24 },
    { id: "shaders", he: "קאש של כרטיס המסך (שיידרים)", en: "Graphics card cache (shaders)", noteHe: "נבנה מחדש; משחק ראשון אחרי הניקוי נטען קצת יותר לאט", noteEn: "Built again; the first game after it loads a bit slower", dirs: [join(local, "NVIDIA", "DXCache"), join(local, "NVIDIA", "GLCache"), join(local, "D3DSCache"), join(local, "AMD", "DxCache"), join(local, "AMD", "DxcCache"), join(local, "AMD", "GLCache")] },
    { id: "chrome", he: "קאש של Chrome", en: "Chrome cache", noteHe: "דפים נטענים מחדש מהרשת; הסיסמאות וההיסטוריה נשארות", noteEn: "Pages load again from the web; passwords and history stay", dirs: chromeLike(join(local, "Google", "Chrome", "User Data")), closeFirst: ["chrome.exe"] },
    { id: "edge", he: "קאש של Edge", en: "Edge cache", noteHe: "דפים נטענים מחדש מהרשת; הסיסמאות וההיסטוריה נשארות", noteEn: "Pages load again from the web; passwords and history stay", dirs: chromeLike(join(local, "Microsoft", "Edge", "User Data")), closeFirst: ["msedge.exe"] },
    { id: "crash", he: "דוחות קריסה", en: "Crash reports", noteHe: "קבצים שנשמרו אחרי קריסות", noteEn: "Saved after programs crashed", dirs: [join(local, "CrashDumps"), join(local, "Microsoft", "Windows", "WER", "ReportArchive")] },
    { id: "steam-shaders", he: "קאש שיידרים של Steam", en: "Steam shader cache", noteHe: "Steam מוריד או בונה אותו מחדש", noteEn: "Steam downloads or builds it again", dirs: [join(env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Steam", "steamapps", "shadercache")], closeFirst: ["steam.exe"] },
  ];
}

/**
 * Size of a folder's contents (only files old enough, when asked): 16 folders read at once, so a temp folder with
 * a hundred thousand files is measured in seconds, not minutes; at most 300,000 files are counted.
 */
async function measure(dir: string, olderThanMs: number): Promise<number> {
  let total = 0;
  let files = 0;
  const now = Date.now();
  const queue = [dir];
  const worker = async () => {
    for (let d = queue.pop(); d !== undefined; d = queue.pop()) {
      const entries = await readdir(d, { withFileTypes: true }).catch(() => []);
      await Promise.all(
        entries.map(async (e) => {
          const p = join(d!, e.name);
          if (e.isDirectory()) queue.push(p);
          else if (e.isFile() && files++ < 300_000) {
            const st = await stat(p).catch(() => undefined);
            if (st && now - st.mtimeMs >= olderThanMs) total += st.size;
          }
        }),
      );
    }
  };
  // Workers start as folders appear: keep going while there is work.
  while (queue.length) await Promise.all(Array.from({ length: Math.min(16, queue.length) }, worker));
  return total;
}

/** Programs running now (Windows: tasklist), lower-case image names. */
async function running(): Promise<Set<string>> {
  if (process.platform !== "win32") return new Set();
  const out = await new Promise<string>((done) => execFile("tasklist", ["/fo", "csv", "/nh"], { windowsHide: true, timeout: 15_000 }, (_e, o) => done(String(o ?? ""))));
  return new Set([...out.matchAll(/^"([^"]+)"/gm)].map((m) => m[1]!.toLowerCase()));
}

/** What each place holds now, and whether a program must be closed first. */
export async function measureSpots(spots = cleanSpots()): Promise<Array<{ id: string; he: string; en: string; noteHe: string; noteEn: string; bytes: number; closeFirst?: string[] }>> {
  const live = await running();
  return Promise.all(
    spots.map(async (s) => {
      const bytes = (await Promise.all(s.dirs.map((d) => measure(d, (s.olderThanHours ?? 0) * 3_600_000)))).reduce((a, b) => a + b, 0);
      const open = (s.closeFirst ?? []).filter((p) => live.has(p.toLowerCase()));
      return { id: s.id, he: s.he, en: s.en, noteHe: s.noteHe, noteEn: s.noteEn, bytes, ...(open.length ? { closeFirst: open } : {}) };
    }),
  );
}

/**
 * Deletes the contents of the chosen places: files old enough; files in use are skipped; empty folders inside go too.
 *
 * @param ids - The places the person ticked.
 * @param spots - The places (for tests).
 * @returns Bytes freed, and files that could not be deleted (in use).
 */
export async function cleanSpotsNow(ids: string[], spots = cleanSpots()): Promise<{ freed: number; skipped: number }> {
  let freed = 0;
  let skipped = 0;
  const now = Date.now();
  const live = await running();
  const clean = async (d: string, olderThanMs: number): Promise<boolean> => {
    let empty = true;
    for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) {
      const p = join(d, e.name);
      if (e.isSymbolicLink()) {
        empty = false;
        continue;
      }
      if (e.isDirectory()) {
        if (await clean(p, olderThanMs)) await rmdir(p).catch(() => (empty = false));
        else empty = false;
      } else if (e.isFile()) {
        const st = await stat(p).catch(() => undefined);
        if (!st || now - st.mtimeMs < olderThanMs) {
          empty = false;
          continue;
        }
        try {
          await rm(p, { force: true });
          freed += st.size;
        } catch {
          skipped++;
          empty = false;
        }
      }
    }
    return empty;
  };
  for (const s of spots.filter((x) => ids.includes(x.id))) {
    // A browser or Steam that is open keeps its cache: it is skipped, not broken.
    if ((s.closeFirst ?? []).some((p) => live.has(p.toLowerCase()))) continue;
    for (const d of s.dirs) await clean(d, (s.olderThanHours ?? 0) * 3_600_000);
  }
  return { freed, skipped };
}

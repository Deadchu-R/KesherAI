/**
 * Storage, like Android's Storage settings and Files by Google (asked for: "see everything, delete, and suggest
 * things like compressing"), inside PC Health:
 * - what takes the space, by kind (videos, pictures, music, documents, downloads, apps…), from the person's own
 *   folders;
 * - cards to clean in one press: large files, old downloads, installers already used, duplicates, old screenshots,
 *   videos that can be made smaller;
 * - every program on the computer, biggest first, with its own uninstaller.
 *
 * Safety: deleted files go to the Recycle Bin / Trash (they can be restored), never deleted outright. The page sends
 * only ids from the last scan; each id is a file or program this computer listed, so no outside path is acted on.
 * Only the person's own folders are scanned (never Windows or program folders). Uninstalling runs the program's
 * own uninstaller, which asks the person itself.
 */
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { open, readdir, readFile, stat } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { basename, dirname, extname, join, resolve, sep } from "node:path";

/** What a file is. */
export type FileKind = "video" | "image" | "audio" | "document" | "archive" | "other";

/** One file the page may show and act on. */
export interface StorageFile {
  id: string;
  name: string;
  /** The folder, shortened for showing (home becomes ~). */
  folder: string;
  bytes: number;
  kind: FileKind;
  /** Last changed (ms). */
  mtime: number;
}

/** One program on the computer. */
export interface InstalledApp {
  id: string;
  name: string;
  publisher?: string;
  bytes?: number;
  installed?: string;
  canUninstall: boolean;
  /** Where it comes from (Windows, Flatpak, Debian package). */
  source: "windows" | "flatpak" | "dpkg";
}

/** A cleaning card. */
export interface StorageCard {
  id: "large" | "old-downloads" | "installers" | "duplicates" | "screenshots" | "compress-videos";
  files: StorageFile[];
  bytes: number;
}

/** One scan's result. */
export interface StorageScan {
  at: string;
  /** Bytes by kind, and the person's folders' totals. */
  kinds: Record<FileKind, number>;
  folders: Array<{ name: string; bytes: number }>;
  /** The biggest files of each kind (for browsing). */
  top: Record<FileKind, StorageFile[]>;
  cards: StorageCard[];
  partial: boolean;
}

const EXT: Record<FileKind, RegExp> = {
  video: /^\.(mp4|mkv|mov|avi|wmv|webm|m4v|flv|mpg|mpeg|3gp|ts)$/i,
  image: /^\.(jpe?g|png|gif|webp|heic|heif|bmp|tiff?|raw|cr2|nef|arw|dng|psd)$/i,
  audio: /^\.(mp3|wav|flac|m4a|aac|ogg|opus|wma|aiff?)$/i,
  document: /^\.(pdf|docx?|xlsx?|pptx?|odt|ods|odp|txt|md|rtf|csv|epub)$/i,
  archive: /^\.(zip|rar|7z|tar|gz|bz2|xz|iso|img|exe|msi|dmg|pkg|deb|rpm|appimage|apk)$/i,
  other: /$^/,
};
const INSTALLER = /\.(exe|msi|iso|dmg|pkg|deb|rpm|appimage|apk|zip|rar|7z)$/i;
const SCREENSHOT = /(screenshot|screen shot|צילום מסך|snip|capture)/i;
const DAY = 86_400_000;
const MB = 1024 ** 2;

/** What kind a file name is. */
export function fileKind(name: string): FileKind {
  const e = extname(name);
  for (const k of ["video", "image", "audio", "document", "archive"] as const) if (EXT[k].test(e)) return k;
  return "other";
}

function run(file: string, args: string[], timeoutMs = 20_000): Promise<{ code: number; out: string }> {
  return new Promise((done) => {
    execFile(file, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 32 * MB }, (err, stdout) => done({ code: err ? 1 : 0, out: String(stdout ?? "") }));
  });
}

/** The person's own folders (Windows' known folders, Linux's XDG user folders). */
export async function userFolders(home = homedir()): Promise<Array<{ name: string; path: string }>> {
  const names = ["Desktop", "Documents", "Downloads", "Pictures", "Videos", "Music"];
  const out = new Map<string, string>(names.map((n) => [n, join(home, n)]));
  if (platform() === "linux") {
    const dirs = await readFile(join(process.env.XDG_CONFIG_HOME || join(home, ".config"), "user-dirs.dirs"), "utf8").catch(() => "");
    const map: Record<string, string> = { DESKTOP: "Desktop", DOCUMENTS: "Documents", DOWNLOAD: "Downloads", PICTURES: "Pictures", VIDEOS: "Videos", MUSIC: "Music" };
    for (const m of dirs.matchAll(/^XDG_(\w+)_DIR="(.+)"$/gm)) {
      const n = map[m[1]!];
      if (n) out.set(n, m[2]!.replace(/^\$HOME/, home));
    }
  } else if (platform() === "win32") {
    // Known folders may be moved (to OneDrive or another drive).
    const ps = "[Environment]::GetFolderPath('Desktop');[Environment]::GetFolderPath('MyDocuments');[Environment]::GetFolderPath('MyPictures');[Environment]::GetFolderPath('MyVideos');[Environment]::GetFolderPath('MyMusic');(New-Object -ComObject Shell.Application).NameSpace('shell:Downloads').Self.Path";
    const r = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps]);
    const [desk, docs, pics, vids, music, down] = r.out.split(/\r?\n/).map((s) => s.trim());
    for (const [n, p] of [["Desktop", desk], ["Documents", docs], ["Pictures", pics], ["Videos", vids], ["Music", music], ["Downloads", down]] as const) if (p) out.set(n, p);
  }
  const list = [...out].map(([name, path]) => ({ name, path: resolve(path) })).filter((f) => existsSync(f.path));
  // A folder inside another one (Pictures inside Documents) is counted once.
  return list.filter((f, i) => !list.some((g, j) => j !== i && f.path.startsWith(g.path + sep)));
}

/** Two files are the same: first and last 64 KB, then all of it. */
async function sameHash(path: string, size: number, full: boolean): Promise<string> {
  if (full) {
    return new Promise((done, fail) => {
      const h = createHash("sha1");
      createReadStream(path).on("data", (c) => h.update(c)).on("end", () => done(h.digest("hex"))).on("error", fail);
    });
  }
  const f = await open(path, "r");
  try {
    const n = Math.min(65536, size);
    const a = Buffer.alloc(n);
    const b = Buffer.alloc(n);
    await f.read(a, 0, n, 0);
    await f.read(b, 0, n, Math.max(0, size - n));
    return createHash("sha1").update(a).update(b).digest("hex");
  } finally {
    await f.close();
  }
}

/** Keeps the files of the last scan and the programs of the last list, by id. */
export class Storage {
  private files = new Map<string, string>();
  private apps = new Map<string, { app: InstalledApp; uninstall: { file: string; args: string[] } }>();
  private scanning: Promise<StorageScan> | undefined;
  last: StorageScan | undefined;

  /** @param home - The home folder (a test gives its own). */
  constructor(private home = homedir()) {}

  private short(path: string): string {
    return path.startsWith(this.home) ? `~${path.slice(this.home.length)}` : path;
  }

  private remember(path: string, bytes: number, mtime: number): StorageFile {
    const id = createHash("sha1").update(path).digest("hex").slice(0, 16);
    this.files.set(id, path);
    return { id, name: basename(path), folder: this.short(dirname(path)), bytes, kind: fileKind(path), mtime };
  }

  /** Walks the person's folders (at most 400,000 entries or 25 s, then partial). */
  scan(): Promise<StorageScan> {
    this.scanning ??= this.doScan().finally(() => (this.scanning = undefined));
    return this.scanning;
  }

  private async doScan(): Promise<StorageScan> {
    const started = Date.now();
    const folders = await userFolders(this.home);
    const all: Array<{ path: string; bytes: number; mtime: number; folder: string }> = [];
    let seen = 0;
    let partial = false;
    const totals = new Map<string, number>();
    for (const f of folders) {
      const stack = [f.path];
      while (stack.length) {
        if (seen > 400_000 || Date.now() - started > 25_000) {
          partial = true;
          break;
        }
        const dir = stack.pop()!;
        const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
        for (const e of entries) {
          seen++;
          if (e.name.startsWith(".") || e.name === "node_modules") continue;
          const p = join(dir, e.name);
          if (e.isDirectory()) stack.push(p);
          else if (e.isFile()) {
            const st = await stat(p).catch(() => undefined);
            if (!st) continue;
            totals.set(f.name, (totals.get(f.name) ?? 0) + st.size);
            all.push({ path: p, bytes: st.size, mtime: st.mtimeMs, folder: f.name });
          }
        }
      }
    }
    this.files.clear();
    const kinds: Record<FileKind, number> = { video: 0, image: 0, audio: 0, document: 0, archive: 0, other: 0 };
    for (const f of all) kinds[fileKind(f.path)] += f.bytes;
    const bySize = [...all].sort((a, b) => b.bytes - a.bytes);
    const top = Object.fromEntries((Object.keys(kinds) as FileKind[]).map((k) => [k, bySize.filter((f) => fileKind(f.path) === k).slice(0, 150).map((f) => this.remember(f.path, f.bytes, f.mtime))])) as Record<FileKind, StorageFile[]>;
    const now = Date.now();
    const card = (id: StorageCard["id"], list: typeof all): StorageCard => {
      const files = list.slice(0, 200).map((f) => this.remember(f.path, f.bytes, f.mtime));
      return { id, files, bytes: files.reduce((n, f) => n + f.bytes, 0) };
    };
    const cards: StorageCard[] = [
      card("large", bySize.filter((f) => f.bytes >= 500 * MB)),
      card("old-downloads", bySize.filter((f) => f.folder === "Downloads" && now - f.mtime > 90 * DAY && !INSTALLER.test(f.path))),
      card("installers", bySize.filter((f) => f.folder === "Downloads" && INSTALLER.test(f.path) && now - f.mtime > 7 * DAY)),
      card("screenshots", bySize.filter((f) => fileKind(f.path) === "image" && SCREENSHOT.test(f.path) && now - f.mtime > 60 * DAY)),
      card("compress-videos", bySize.filter((f) => fileKind(f.path) === "video" && f.bytes >= 300 * MB && !/\.compressed\./i.test(f.path))),
      card("duplicates", await this.duplicates(bySize, started)),
    ].filter((c) => c.files.length > 0);
    const result: StorageScan = { at: new Date().toISOString(), kinds, folders: folders.map((f) => ({ name: f.name, bytes: totals.get(f.name) ?? 0 })), top, cards, partial };
    this.last = result;
    return result;
  }

  /** Extra copies (the oldest of each group is kept and not listed); files of 1 MB and more. */
  private async duplicates(bySize: Array<{ path: string; bytes: number; mtime: number; folder: string }>, started: number) {
    const groups = new Map<number, typeof bySize>();
    for (const f of bySize) if (f.bytes >= MB) groups.set(f.bytes, [...(groups.get(f.bytes) ?? []), f]);
    const extra: typeof bySize = [];
    for (const list of [...groups.values()].filter((g) => g.length > 1).slice(0, 300)) {
      if (Date.now() - started > 60_000) break;
      const quick = new Map<string, typeof bySize>();
      for (const f of list) {
        const h = await sameHash(f.path, f.bytes, false).catch(() => "");
        if (h) quick.set(h, [...(quick.get(h) ?? []), f]);
      }
      for (const same of quick.values()) {
        if (same.length < 2) continue;
        // Small enough to read whole (under 200 MB): confirm the copies are the same.
        const confirmed = same[0]!.bytes < 200 * MB ? await this.confirmSame(same) : same;
        if (confirmed.length < 2) continue;
        const keep = confirmed.reduce((a, b) => (a.mtime <= b.mtime ? a : b));
        extra.push(...confirmed.filter((f) => f !== keep));
      }
    }
    return extra.sort((a, b) => b.bytes - a.bytes);
  }

  private async confirmSame<T extends { path: string; bytes: number }>(files: T[]): Promise<T[]> {
    const byHash = new Map<string, T[]>();
    for (const f of files) {
      const h = await sameHash(f.path, f.bytes, true).catch(() => "");
      if (h) byHash.set(h, [...(byHash.get(h) ?? []), f]);
    }
    return [...byHash.values()].sort((a, b) => b.length - a.length)[0] ?? [];
  }

  /** Lists one more file (a compressed copy just made), so the page can act on it. */
  async add(path: string): Promise<StorageFile | undefined> {
    const st = await stat(path).catch(() => undefined);
    return st?.isFile() ? this.remember(path, st.size, st.mtimeMs) : undefined;
  }

  /** The path of a file from the last scan (undefined when it is not one). */
  pathOf(id: string): string | undefined {
    return this.files.get(id);
  }

  /**
   * Moves chosen files to the Recycle Bin / Trash.
   *
   * @param trash - Moves one path to the bin (Electron's shell.trashItem in the app).
   */
  async remove(ids: string[], trash: (path: string) => Promise<void>): Promise<{ done: string[]; failed: Array<{ id: string; error: string }>; freed: number }> {
    const done: string[] = [];
    const failed: Array<{ id: string; error: string }> = [];
    let freed = 0;
    for (const id of ids.slice(0, 2000)) {
      const path = this.files.get(id);
      if (!path) {
        failed.push({ id, error: "Not in the last scan; scan again." });
        continue;
      }
      try {
        const st = await stat(path);
        await trash(path);
        freed += st.size;
        done.push(id);
        this.files.delete(id);
      } catch (err) {
        failed.push({ id, error: (err as Error).message });
      }
    }
    if (this.last) {
      const gone = new Set(done);
      for (const k of Object.keys(this.last.top) as FileKind[]) this.last.top[k] = this.last.top[k].filter((f) => !gone.has(f.id));
      this.last.cards = this.last.cards.map((c) => ({ ...c, files: c.files.filter((f) => !gone.has(f.id)) })).map((c) => ({ ...c, bytes: c.files.reduce((n, f) => n + f.bytes, 0) })).filter((c) => c.files.length);
    }
    return { done, failed, freed };
  }

  /** Every program on the computer, biggest first. */
  async listApps(): Promise<InstalledApp[]> {
    this.apps.clear();
    const add = (app: Omit<InstalledApp, "id">, uninstall?: { file: string; args: string[] }) => {
      const id = createHash("sha1").update(`${app.source}:${app.name}:${app.installed ?? ""}`).digest("hex").slice(0, 16);
      if (this.apps.has(id)) return;
      const full = { ...app, id, canUninstall: !!uninstall };
      this.apps.set(id, { app: full, uninstall: uninstall ?? { file: "", args: [] } });
    };
    if (platform() === "win32") {
      const ps = "$k='HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'; Get-ItemProperty $k -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -and $_.SystemComponent -ne 1 -and -not $_.ParentKeyName } | Select-Object DisplayName,Publisher,EstimatedSize,InstallDate,UninstallString | ConvertTo-Json -Compress";
      const r = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], 30_000);
      let rows: Array<{ DisplayName: string; Publisher?: string; EstimatedSize?: number; InstallDate?: string; UninstallString?: string }> = [];
      try {
        const j = JSON.parse(r.out || "[]") as unknown;
        rows = (Array.isArray(j) ? j : [j]) as typeof rows;
      } catch {
        /* none */
      }
      for (const a of rows) {
        const u = String(a.UninstallString ?? "").trim();
        const date = /^(\d{4})(\d{2})(\d{2})$/.exec(String(a.InstallDate ?? ""));
        add(
          { name: String(a.DisplayName).slice(0, 200), ...(a.Publisher ? { publisher: String(a.Publisher).slice(0, 120) } : {}), ...(a.EstimatedSize ? { bytes: Number(a.EstimatedSize) * 1024 } : {}), ...(date ? { installed: `${date[1]}-${date[2]}-${date[3]}` } : {}), canUninstall: false, source: "windows" },
          u ? { file: "cmd.exe", args: ["/d", "/s", "/c", `start "" ${u}`] } : undefined,
        );
      }
    } else if (platform() === "linux") {
      const fp = await run("flatpak", ["list", "--app", "--columns=application,name,size,installation"]);
      for (const line of fp.out.split("\n").filter(Boolean)) {
        const [appId, name, size, where] = line.split("\t");
        if (!appId) continue;
        const bytes = parseSize(size ?? "");
        add({ name: name || appId, ...(bytes ? { bytes } : {}), canUninstall: false, source: "flatpak" }, { file: "flatpak", args: ["uninstall", "-y", ...(where === "user" ? ["--user"] : []), appId] });
      }
      const dp = await run("dpkg-query", ["-W", "-f", "${Package}\t${Installed-Size}\t${Priority}\n"]);
      for (const line of dp.out.split("\n").filter(Boolean)) {
        const [pkg, kb, prio] = line.split("\t");
        if (!pkg || prio === "required" || prio === "important") continue;
        // Removing a system package needs the administrator: listed, removed by the person (sudo apt remove).
        add({ name: pkg, ...(kb ? { bytes: Number(kb) * 1024 } : {}), canUninstall: false, source: "dpkg" });
      }
    }
    return [...this.apps.values()].map((a) => a.app).sort((a, b) => (b.bytes ?? 0) - (a.bytes ?? 0));
  }

  /** Starts a program's own uninstaller (it asks the person itself). */
  async uninstall(id: string): Promise<void> {
    const a = this.apps.get(id);
    if (!a || !a.app.canUninstall) throw new Error("This program cannot be removed from here.");
    await new Promise<void>((done, fail) => {
      const p = spawn(a.uninstall.file, a.uninstall.args, { detached: true, stdio: "ignore", windowsHide: false, windowsVerbatimArguments: a.uninstall.file === "cmd.exe" });
      p.once("error", fail);
      p.once("spawn", () => {
        p.unref();
        done();
      });
    });
  }
}

/** "1.2 GB" / "300 MB" (Flatpak's sizes) in bytes. */
export function parseSize(s: string): number {
  const m = /([\d.,]+)\s*([kKmMgGtT]?)B/.exec(s.replace(/\u00a0/g, " "));
  if (!m) return 0;
  const n = Number(m[1]!.replace(",", "."));
  return Math.round(n * 1024 ** ({ "": 0, k: 1, m: 2, g: 3, t: 4 }[m[2]!.toLowerCase()] ?? 0));
}

/**
 * Moves a file to the Recycle Bin / Trash: Electron's shell.trashItem in the app, else the system's own command.
 *
 * @param path - The file.
 */
export async function moveToTrash(path: string): Promise<void> {
  try {
    const name = "electron";
    const electron = (await import(name)) as unknown as { shell?: { trashItem?: (p: string) => Promise<void> } };
    if (electron.shell?.trashItem) return await electron.shell.trashItem(path);
  } catch {
    /* not in the app */
  }
  const r =
    platform() === "win32"
      ? await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($args[0],'OnlyErrorDialogs','SendToRecycleBin')", path])
      : platform() === "darwin"
        ? await run("osascript", ["-e", `tell application "Finder" to delete POSIX file ${JSON.stringify(path)}`])
        : await run("gio", ["trash", path]);
  if (r.code !== 0) throw new Error("It could not be moved to the bin.");
}

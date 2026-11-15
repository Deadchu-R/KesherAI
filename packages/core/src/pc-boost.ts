/**
 * More of PC health's "Speed up" (Windows): the Recycle Bin, Windows Update's download cache (with Windows' own
 * administrator prompt), programs that hold the most memory (closed only when the person presses Close), and the
 * programs that start with Windows (shown; changed in Windows' own settings). Every action is the person's.
 */
import { execFile } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

const ps = (command: string, timeoutMs = 30_000) =>
  new Promise<{ ok: boolean; out: string }>((done) =>
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], { windowsHide: true, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (e, out) => done({ ok: !e, out: String(out ?? "") })),
  );

/** Windows parts, security, drivers and KesherAI itself: never offered for closing. */
const NEVER_CLOSE = /^(system|idle|registry|smss|csrss|wininit|winlogon|services|lsass|lsaiso|svchost|fontdrvhost|dwm|explorer|sihost|ctfmon|taskhostw|runtimebroker|searchhost|startmenuexperiencehost|shellexperiencehost|textinputhost|securityhealth\w*|msmpeng|nissrv|mpdefendercoreservice|smartscreen|audiodg|conhost|dllhost|wmiprvse|spoolsv|memory compression|secure system|nvcontainer|nvdisplay\.container|nvidia web helper|amdrsserv|atieclxx|kesherai|llama-server|sd|whisper-server|comfyui|python|pythonw|node|electron)$/i;

/** One program holding memory. */
export interface MemoryProgram {
  pid: number;
  name: string;
  /** Working set, bytes. */
  bytes: number;
  title?: string;
}

/**
 * Programs by the memory they hold (biggest first), without Windows' own parts and KesherAI.
 *
 * @param rows - Rows from Get-Process (for tests); read from the system when left out.
 */
export async function memoryPrograms(rows?: Array<{ Id: number; ProcessName: string; WorkingSet64: number; MainWindowTitle?: string; SessionId?: number }>): Promise<MemoryProgram[]> {
  let list = rows;
  if (!list) {
    if (process.platform !== "win32") return [];
    const r = await ps("Get-Process | Where-Object { $_.SessionId -ne 0 } | Select-Object Id,ProcessName,WorkingSet64,MainWindowTitle,SessionId | ConvertTo-Json -Compress");
    try {
      const j = JSON.parse(r.out || "[]") as unknown;
      list = (Array.isArray(j) ? j : [j]) as NonNullable<typeof rows>;
    } catch {
      list = [];
    }
  }
  // One row per program (Chrome has many processes): the memory of all its processes together.
  const by = new Map<string, MemoryProgram & { pids: number[] }>();
  for (const p of list) {
    if (!p?.ProcessName || NEVER_CLOSE.test(p.ProcessName) || p.SessionId === 0 || p.Id === process.pid) continue;
    const key = p.ProcessName.toLowerCase();
    const cur = by.get(key) ?? { pid: p.Id, name: p.ProcessName, bytes: 0, pids: [] };
    cur.bytes += Number(p.WorkingSet64) || 0;
    cur.pids.push(p.Id);
    if (p.MainWindowTitle && !cur.title) {
      cur.title = String(p.MainWindowTitle).slice(0, 120);
      cur.pid = p.Id;
    }
    by.set(key, cur);
  }
  return [...by.values()].filter((p) => p.bytes > 50 * 1024 ** 2).sort((a, b) => b.bytes - a.bytes).slice(0, 25).map(({ pids: _p, ...p }) => p);
}

/**
 * Closes a program the person chose: first asks it to close (it may save or ask), and only with `force` ends it.
 *
 * @param name - The program's name, as listed.
 * @param force - End it even if it does not close (unsaved work is lost).
 */
export async function closeProgram(name: string, force = false): Promise<{ ok: boolean; message: string }> {
  if (!/^[\w .()+-]{1,80}$/.test(name) || NEVER_CLOSE.test(name)) return { ok: false, message: "This program is not closed from here." };
  if (process.platform !== "win32") return { ok: false, message: "Only on Windows." };
  const r = await new Promise<{ ok: boolean; out: string }>((done) =>
    execFile("taskkill", ["/IM", `${name}.exe`, "/T", ...(force ? ["/F"] : [])], { windowsHide: true, timeout: 20_000 }, (e, out, err) => done({ ok: !e, out: String(out || err || "") })),
  );
  return { ok: r.ok, message: r.out.trim().slice(0, 300) };
}

/** The Recycle Bin's size and item count. */
export async function recycleBin(): Promise<{ bytes: number; items: number }> {
  if (process.platform !== "win32") return { bytes: 0, items: 0 };
  const r = await ps("$i=(New-Object -ComObject Shell.Application).NameSpace(10).Items(); $s=0; foreach($x in $i){ $s += $x.Size }; @{ items=$i.Count; bytes=$s } | ConvertTo-Json -Compress", 60_000);
  try {
    const j = JSON.parse(r.out) as { items?: number; bytes?: number };
    return { bytes: Number(j.bytes) || 0, items: Number(j.items) || 0 };
  } catch {
    return { bytes: 0, items: 0 };
  }
}

/** Empties the Recycle Bin (for good). */
export async function emptyRecycleBin(): Promise<boolean> {
  if (process.platform !== "win32") return false;
  return (await ps("Clear-RecycleBin -Force -ErrorAction SilentlyContinue", 120_000)).ok;
}

/** Where Windows Update keeps downloaded updates (installed ones are not needed again). */
export const UPDATE_CACHE = join(process.env.SystemRoot ?? "C:\\Windows", "SoftwareDistribution", "Download");

/** The size of Windows Update's download cache (undefined when it cannot be read without administrator rights). */
export async function updateCacheBytes(dir = UPDATE_CACHE): Promise<number | undefined> {
  let total = 0;
  let readable = true;
  const walk = async (d: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      readable = false;
      return;
    }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile()) total += (await stat(p).catch(() => undefined))?.size ?? 0;
    }
  };
  await walk(dir);
  return readable ? total : undefined;
}

/**
 * Clears Windows Update's download cache: Windows shows its own administrator prompt, the update service stops,
 * the downloaded files go, and the service starts again. Returns when the prompt was shown (the work runs in the
 * window Windows opens).
 */
export async function clearUpdateCache(): Promise<{ ok: boolean; message: string }> {
  if (process.platform !== "win32") return { ok: false, message: "Only on Windows." };
  const inner = `Stop-Service wuauserv,bits -Force -ErrorAction SilentlyContinue; Remove-Item '${UPDATE_CACHE.replace(/'/g, "''")}\\*' -Recurse -Force -ErrorAction SilentlyContinue; Start-Service wuauserv,bits -ErrorAction SilentlyContinue`;
  const encoded = Buffer.from(inner, "utf16le").toString("base64");
  const r = await ps(`Start-Process powershell.exe -Verb RunAs -WindowStyle Hidden -Wait -ArgumentList '-NoProfile','-EncodedCommand','${encoded}'`, 300_000);
  return r.ok ? { ok: true, message: "done" } : { ok: false, message: "Windows' administrator prompt was declined or closed." };
}

/** Programs that start with Windows (the person's and the computer's), for showing. */
export async function startupPrograms(): Promise<Array<{ name: string; where: string }>> {
  if (process.platform !== "win32") return [];
  const r = await ps("Get-CimInstance Win32_StartupCommand | Select-Object Name,Location | ConvertTo-Json -Compress");
  try {
    const j = JSON.parse(r.out || "[]") as unknown;
    return ((Array.isArray(j) ? j : [j]) as Array<{ Name?: string; Location?: string }>).filter((x) => x?.Name).map((x) => ({ name: String(x.Name).slice(0, 120), where: String(x.Location ?? "").slice(0, 200) }));
  } catch {
    return [];
  }
}

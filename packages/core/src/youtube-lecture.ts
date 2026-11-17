import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { DownloadManager } from "@kesher/downloads";
import { waitForDownload } from "./llamacpp.js";

/**
 * A YouTube lecture as a Study lecture (RESEARCH_LOG "Students, part 20" #1, like YouLearn, NoteGPT and Feynman AI):
 * its captions (the lecturer's own, else YouTube's automatic ones, Hebrew first) through yt-dlp, as text with a [m:ss]
 * mark every half minute, so each part links back to its minute. No captions: the sound, for whisper.
 * yt-dlp (free, open source) is downloaded the first time she uses it, into KesherAI's engines folder.
 */

const run = promisify(execFile);
const FILES: Record<string, string> = { win32: "yt-dlp.exe", linux: "yt-dlp_linux", darwin: "yt-dlp_macos" };
let installing: Promise<string> | undefined;

/** The YouTube video's id from a link (watch, youtu.be, shorts, live, embed), or undefined. */
export function youtubeId(link: string): string | undefined {
  let u: URL;
  try {
    u = new URL(link.trim());
  } catch {
    return undefined;
  }
  if (!/^(www\.|m\.|music\.)?(youtube\.com|youtu\.be)$/.test(u.hostname)) return undefined;
  const id = u.hostname === "youtu.be" ? u.pathname.slice(1) : u.searchParams.get("v") ?? /^\/(shorts|live|embed)\/([\w-]{11})/.exec(u.pathname)?.[2] ?? "";
  return /^[\w-]{11}$/.test(id) ? id : undefined;
}

/**
 * A WebVTT caption file as lecture text: the words in order (YouTube's automatic captions repeat each line as it
 * scrolls; repeats are dropped), with a [m:ss] mark at the start and then about every 30 seconds.
 */
export function vttText(vtt: string): string {
  const out: string[] = [];
  let lastMark = -1;
  let line = "";
  let seen = "";
  for (const block of vtt.replace(/\r/g, "").split(/\n\n+/)) {
    const m = /(\d+):(\d\d):(\d\d)\.\d+\s+-->/.exec(block) ?? /(?:^|\n)()(\d\d):(\d\d)\.\d+\s+-->/.exec(block);
    if (!m) continue;
    const sec = Number(m[1] || 0) * 3600 + Number(m[2]) * 60 + Number(m[3]);
    const words = block.split("\n").filter((l) => !/-->/.test(l) && !/^(WEBVTT|Kind:|Language:|NOTE)/.test(l) && !/^\d+$/.test(l.trim())).join(" ").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
    if (!words) continue;
    // The scrolling captions: keep only what is new since the last cue.
    const fresh = words.startsWith(seen) ? words.slice(seen.length).trim() : seen.endsWith(words) ? "" : words;
    seen = words;
    if (!fresh) continue;
    if (lastMark < 0 || sec - lastMark >= 30) {
      if (line) out.push(line);
      const mm = Math.floor(sec / 60);
      line = `[${mm >= 60 ? `${Math.floor(mm / 60)}:${String(mm % 60).padStart(2, "0")}` : mm}:${String(sec % 60).padStart(2, "0")}] ${fresh}`;
      lastMark = sec;
    } else line += ` ${fresh}`;
  }
  if (line) out.push(line);
  return out.join("\n");
}

/** yt-dlp on this computer: on the PATH, or downloaded once into the engines folder. */
export async function ensureYtDlp(o: { dir: string; downloads: DownloadManager }): Promise<string> {
  const works = async (cmd: string) => run(cmd, ["--version"], { timeout: 30_000, windowsHide: true }).then(() => true, () => false);
  if (await works("yt-dlp")) return "yt-dlp";
  const file = FILES[process.platform];
  if (!file) throw new Error(`There is no yt-dlp build for ${process.platform}.`);
  const home = join(o.dir, "yt-dlp");
  const exe = join(home, process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp");
  if (existsSync(exe) && (await works(exe))) return exe;
  installing ??= (async () => {
    await mkdir(home, { recursive: true });
    const job = o.downloads.enqueue({ url: `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${file}`, dest: exe, label: "yt-dlp (reads YouTube lectures)" });
    await waitForDownload(o.downloads, job.id);
    // The program is checked against yt-dlp's own published SHA-256 list before it ever runs.
    const sums = await fetch("https://github.com/yt-dlp/yt-dlp/releases/latest/download/SHA2-256SUMS").then((r) => (r.ok ? r.text() : ""), () => "");
    const want = sums.split("\n").map((l) => l.trim().split(/\s+/)).find((p) => p[1] === file)?.[0]?.toLowerCase();
    const got = createHash("sha256").update(await readFile(exe)).digest("hex");
    if (!want || want !== got) {
      await rm(exe, { force: true });
      throw new Error("The yt-dlp download did not match its published fingerprint, so it was removed. Try again later.");
    }
    if (process.platform !== "win32") await chmod(exe, 0o755);
    if (!(await works(exe))) throw new Error("yt-dlp did not start after downloading.");
    return exe;
  })().finally(() => {
    installing = undefined;
  });
  return installing;
}

/**
 * A YouTube video's title and its captions as lecture text; when it has none, its sound file for whisper.
 *
 * @param ytdlp - The yt-dlp program.
 * @param id - The video's id.
 * @param prefer - Caption languages in order (e.g. he, then en).
 */
export async function youtubeLecture(ytdlp: string, id: string, prefer: string[] = ["he", "iw", "en"]): Promise<{ title: string; text?: string; audio?: string; tmp: string }> {
  const tmp = await mkdtemp(join(tmpdir(), "kesher-yt-"));
  const url = `https://www.youtube.com/watch?v=${id}`;
  const langs = [...prefer, ...prefer.map((l) => `${l}-orig`), `${prefer[0]}.*`, "en.*"].join(",");
  const r = await run(ytdlp, ["--no-playlist", "--skip-download", "--write-subs", "--write-auto-subs", "--sub-langs", langs, "--sub-format", "vtt", "--print", "title", "--no-simulate", "-o", join(tmp, "%(id)s.%(ext)s"), url], { timeout: 180_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
  const title = r.stdout.split("\n").map((l) => l.trim()).filter(Boolean).pop()?.slice(0, 160) || "YouTube";
  const vtts = (await readdir(tmp)).filter((f) => f.endsWith(".vtt"));
  // The lecturer's own captions in her language first, then automatic ones, then any.
  const rank = (f: string) => {
    const lang = /\.([\w-]+)\.vtt$/.exec(f)?.[1] ?? "";
    const i = prefer.findIndex((p) => lang === p || lang.startsWith(`${p}-`));
    return (i < 0 ? 50 : i * 2) + (/orig|auto/.test(lang) ? 1 : 0);
  };
  const pick = vtts.sort((a, b) => rank(a) - rank(b))[0];
  if (pick) {
    const text = vttText(await readFile(join(tmp, pick), "utf8"));
    if (text.trim()) return { title, text, tmp };
  }
  // No captions: the sound only (m4a / webm audio), for whisper.
  await run(ytdlp, ["--no-playlist", "-f", "bestaudio[ext=m4a]/bestaudio", "-o", join(tmp, "audio.%(ext)s"), url], { timeout: 1_800_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
  const audio = (await readdir(tmp)).find((f) => f.startsWith("audio."));
  return { title, ...(audio ? { audio: join(tmp, audio) } : {}), tmp };
}

/** Removes the temporary folder of a fetch. */
export async function cleanYoutube(tmp: string): Promise<void> {
  await rm(tmp, { recursive: true, force: true });
}

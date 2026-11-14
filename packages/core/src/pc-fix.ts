/**
 * PC Health's "Fix it for me" (asked for): a short list of things KesherAI can safely do itself, each with what it
 * frees, chosen by the person and done only after they press the button. Like Windows' Storage Sense "Cleanup
 * recommendations" and CCleaner's Health Check (docs/RESEARCH_LOG.md): the list shows sizes, the sure-safe items are
 * ticked, the ones that lose something are not, and nothing outside KesherAI's own things is touched.
 *
 * - Unload the model from memory (frees RAM and the card's memory; the next chat loads it again).
 * - Old self-work copies (git worktrees with their own packages, often GBs). Their branch stays, so no work is lost;
 *   a copy with changes not saved in a commit is never ticked.
 * - Models KesherAI downloaded and nobody used for 30 days (never ticked; only its own models folder).
 *
 * The client sends only ids; each is looked up again in a fresh list here, so no path from outside is ever acted on.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, readFile, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { folderSize } from "./pc-health.js";

/** One thing KesherAI can do. */
export interface FixAction {
  id: string;
  kind: "unload" | "self-work" | "model" | "engine";
  /** What it is (a model's file name, a copy's date). */
  name: string;
  /** What it frees, when known. */
  bytes?: number;
  /** Sure-safe: ticked to begin with. */
  safe: boolean;
  /** Why it is not ticked, or what to know (short, for the list). */
  note?: "changes" | "loaded-busy" | "unused" | "memory" | "left-over";
  /** Days since last use (models). */
  days?: number;
}

/** A program using the graphics card. */
export interface GpuApp {
  pid: number;
  /** Its program's path (or name). */
  name: string;
  /** Card memory it holds. */
  bytes: number;
}

/**
 * The programs using an NVIDIA card: `nvidia-smi --query-compute-apps=pid,process_name,used_memory --format=csv,noheader,nounits`.
 *
 * @param out - What nvidia-smi printed.
 */
export function parseGpuApps(out: string): GpuApp[] {
  return out
    .split(/\r?\n/)
    .map((l) => l.split(",").map((x) => x.trim()))
    .filter((p) => p.length >= 3 && /^\d+$/.test(p[0]!))
    .map((p) => ({ pid: Number(p[0]), name: p.slice(1, -1).join(","), bytes: (Number(p[p.length - 1]) || 0) * 1024 * 1024 }));
}

/** KesherAI's own engines left running (after an update or a crash) that hold the card. */
function leftOver(apps: GpuApp[], c: FixContext): GpuApp[] {
  const own = new Set(c.ownPids ?? []);
  const dir = c.enginesDir ? resolve(c.enginesDir).toLowerCase() : "";
  return apps.filter((a) => !own.has(a.pid) && a.pid !== process.pid && ((dir && resolve(a.name).toLowerCase().startsWith(dir + sep.toLowerCase())) || /(^|[\\/])(llama-server|sd-server|whisper-server)(\.exe)?$/i.test(a.name)));
}

/** What the list is made from (the server's own state). */
export interface FixContext {
  /** The engine's loaded model, if any. */
  loadedModel?: string;
  /** Chats working now: unloading would cut them off. */
  busy: boolean;
  /** Memory is short (RAM over 85%): unloading is then ticked. */
  memoryShort: boolean;
  modelsDir: string;
  /** When each model was last loaded (path → ISO time). */
  modelUse: Record<string, string>;
  /** The self-work project and its current copy (never offered). */
  selfWork?: { repo: string; worktree: string };
  /** Unloads the engine. */
  unload: () => Promise<void>;
  /** The programs using the graphics card (nvidia-smi), and the processes of the models KesherAI runs now. */
  gpuApps?: () => Promise<GpuApp[]>;
  ownPids?: number[];
  /** KesherAI's engines folder: a program from there that is not running for KesherAI now was left over. */
  enginesDir?: string;
  /** Closes a process (a test gives its own). */
  kill?: (pid: number) => void;
  /** Runs git (a test gives its own). */
  git?: (cwd: string, args: string[]) => Promise<{ code: number; out: string }>;
}

const DAY = 86_400_000;
const MODEL_EXT = /\.(gguf|safetensors|ckpt|bin|onnx)$/i;

function runGit(cwd: string, args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((done) => {
    execFile("git", args, { cwd, timeout: 60_000, windowsHide: true }, (err, stdout, stderr) => done({ code: err ? 1 : 0, out: String(stdout ?? "") + String(stderr ?? "") }));
  });
}

/** Model files under KesherAI's models folder (4 levels deep at most). */
async function ownModels(root: string): Promise<Array<{ path: string; size: number; mtime: number }>> {
  const out: Array<{ path: string; size: number; mtime: number }> = [];
  const walk = async (dir: string, depth: number) => {
    if (depth > 4) return;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) await walk(p, depth + 1);
      else if (e.isFile() && MODEL_EXT.test(e.name)) {
        const st = await stat(p).catch(() => undefined);
        if (st && st.size > 50 * 1024 ** 2) out.push({ path: p, size: st.size, mtime: st.mtimeMs });
      }
    }
  };
  await walk(root, 0);
  return out;
}

/** The self-work copies git knows about (branches kesher-self/…), but not the current one. */
async function selfWorkCopies(c: FixContext): Promise<Array<{ path: string; branch: string }>> {
  if (!c.selfWork || !existsSync(c.selfWork.repo)) return [];
  const git = c.git ?? runGit;
  const list = await git(c.selfWork.repo, ["worktree", "list", "--porcelain"]);
  if (list.code !== 0) return [];
  const out: Array<{ path: string; branch: string }> = [];
  for (const block of list.out.split(/\r?\n\r?\n/)) {
    const path = /^worktree (.+)$/m.exec(block)?.[1]?.trim();
    const branch = /^branch refs\/heads\/(.+)$/m.exec(block)?.[1]?.trim();
    if (!path || !branch || !branch.startsWith("kesher-self/")) continue;
    if (resolve(path) === resolve(c.selfWork.worktree) || resolve(path) === resolve(c.selfWork.repo)) continue;
    out.push({ path, branch });
  }
  return out;
}

/**
 * What KesherAI can do now, biggest first within each kind.
 *
 * @param c - The server's state.
 */
export async function fixActions(c: FixContext): Promise<FixAction[]> {
  const out: FixAction[] = [];
  if (c.loadedModel) out.push({ id: "unload", kind: "unload", name: basename(c.loadedModel), safe: c.memoryShort && !c.busy, ...(c.busy ? { note: "loaded-busy" as const } : c.memoryShort ? { note: "memory" as const } : {}) });
  // A KesherAI engine still running from before (found on the PC: the card stayed full and busy with nothing loaded).
  for (const a of leftOver((await c.gpuApps?.().catch(() => [])) ?? [], c)) out.push({ id: `engine:${a.pid}`, kind: "engine", name: `${basename(a.name)} (${a.pid})`, bytes: a.bytes, safe: true, note: "left-over" });

  const git = c.git ?? runGit;
  const copies = await selfWorkCopies(c);
  const sw: FixAction[] = await Promise.all(
    copies.map(async (w) => {
      const size = existsSync(w.path) ? await folderSize(basename(w.path), w.path, 200_000, 6000) : { bytes: 0 };
      const dirty = existsSync(w.path) ? (await git(w.path, ["status", "--porcelain"])).out.trim() !== "" : false;
      return { id: `self-work:${w.branch}`, kind: "self-work" as const, name: w.branch.replace(/^kesher-self\//, ""), bytes: size.bytes, safe: !dirty, ...(dirty ? { note: "changes" as const } : {}) };
    }),
  );
  out.push(...sw.sort((a, b) => (b.bytes ?? 0) - (a.bytes ?? 0)));

  const now = Date.now();
  const models = (await ownModels(c.modelsDir))
    .filter((m) => !c.loadedModel || resolve(m.path) !== resolve(c.loadedModel))
    .map((m) => {
      const used = Date.parse(c.modelUse[resolve(m.path)] ?? "") || m.mtime;
      return { ...m, days: Math.floor((now - used) / DAY) };
    })
    .filter((m) => m.days >= 30)
    .sort((a, b) => b.size - a.size)
    .slice(0, 8);
  for (const m of models) out.push({ id: `model:${basename(m.path)}:${m.size}`, kind: "model", name: basename(m.path), bytes: m.size, safe: false, note: "unused", days: m.days });
  return out;
}

/**
 * Does the chosen ones. Each id is found again in a fresh list (nothing else is done), and checked again just before.
 *
 * @returns What was done and freed, and what failed.
 */
export async function runFixes(ids: string[], c: FixContext): Promise<{ done: string[]; failed: Array<{ id: string; error: string }>; freed: number }> {
  const want = new Set(ids.map(String).slice(0, 50));
  const all = await fixActions(c);
  const done: string[] = [];
  const failed: Array<{ id: string; error: string }> = [];
  let freed = 0;
  const git = c.git ?? runGit;
  const copies = await selfWorkCopies(c);
  const models = await ownModels(c.modelsDir);
  const root = resolve(c.modelsDir);
  for (const a of all.filter((x) => want.has(x.id))) {
    try {
      if (a.kind === "unload") {
        if (c.busy) throw new Error("A chat is working; try again when it finishes.");
        await c.unload();
      } else if (a.kind === "engine") {
        // Looked up again: still there, still left over (a pid can be reused by another program).
        const pid = Number(a.id.slice("engine:".length));
        const still = leftOver((await c.gpuApps?.().catch(() => [])) ?? [], c).find((x) => x.pid === pid);
        if (!still) throw new Error("It is no longer running.");
        (c.kill ?? ((p: number) => process.kill(p)))(pid);
        freed += still.bytes;
      } else if (a.kind === "self-work") {
        const w = copies.find((x) => `self-work:${x.branch}` === a.id);
        if (!w || !c.selfWork) throw new Error("That copy is gone.");
        // The branch (and its commits) stay; only the folder goes. "--force" is needed for untracked files such as
        // node_modules; a copy with uncommitted changes is not removed unless it was chosen knowingly.
        const r = await git(c.selfWork.repo, ["worktree", "remove", "--force", w.path]);
        if (r.code !== 0) throw new Error(r.out.slice(0, 300) || "git could not remove it.");
        await git(c.selfWork.repo, ["worktree", "prune"]);
        freed += a.bytes ?? 0;
      } else {
        const m = models.find((x) => `model:${basename(x.path)}:${x.size}` === a.id);
        const path = m && resolve(m.path);
        if (!path || !path.startsWith(root + sep)) throw new Error("That model is gone.");
        if (c.loadedModel && resolve(c.loadedModel) === path) throw new Error("That model is loaded.");
        await unlink(path);
        for (let d = dirname(path); d.startsWith(root + sep); d = dirname(d)) if (!(await rmdir(d).then(() => true, () => false))) break;
        freed += a.bytes ?? 0;
      }
      done.push(a.id);
    } catch (err) {
      failed.push({ id: a.id, error: (err as Error).message });
    }
  }
  for (const id of want) if (!all.some((a) => a.id === id)) failed.push({ id, error: "Not on the list any more." });
  return { done, failed, freed };
}

/** When each model was last loaded, kept in a small file (for "not used for 30 days"). */
export class ModelUse {
  private data: Record<string, string> = {};
  private loaded = false;
  /** @param file - Where the record is kept. */
  constructor(private file: string) {}

  /** The record (path → ISO time). */
  async all(): Promise<Record<string, string>> {
    if (!this.loaded) {
      this.loaded = true;
      try {
        const d = JSON.parse(await readFile(this.file, "utf8")) as unknown;
        if (d && typeof d === "object" && !Array.isArray(d)) this.data = d as Record<string, string>;
      } catch {
        /* none yet */
      }
    }
    return this.data;
  }

  /** Notes that a model was loaded now. */
  async used(modelPath: string): Promise<void> {
    const d = await this.all();
    d[resolve(modelPath)] = new Date().toISOString();
    await writeFile(this.file, JSON.stringify(d)).catch(() => undefined);
  }
}

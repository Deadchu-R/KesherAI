import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { readProject } from "./unreal-install.js";
import { readUnityVersion } from "./engine-support.js";

/** A Unity or Unreal project found on this computer. */
export interface GameProject {
  kind: "unity" | "unreal" | "godot";
  name: string;
  path: string;
  engine?: string;
}

const isUnity = (dir: string) => existsSync(join(dir, "Assets")) && existsSync(join(dir, "ProjectSettings"));

const isGodot = (dir: string) => existsSync(join(dir, "project.godot"));

/**
 * The Godot project manager's list (projects.cfg: one `[path]` section per project), on Windows, macOS and Linux.
 *
 * @param home - The home folder.
 * @returns The projects' folders.
 */
export async function godotManagerProjects(home: string): Promise<string[]> {
  const files = [
    join(process.env.APPDATA ?? join(home, "AppData", "Roaming"), "Godot", "projects.cfg"),
    join(home, "Library", "Application Support", "Godot", "projects.cfg"),
    join(home, ".local", "share", "godot", "projects.cfg"),
  ];
  const out: string[] = [];
  for (const f of files) {
    const raw = await readFile(f, "utf8").catch(() => "");
    for (const m of raw.matchAll(/^\[(.+)\]\s*$/gm)) out.push(resolve(m[1]!));
  }
  return out;
}

/** Unity Hub's list of projects (Windows, macOS, Linux). */
async function unityHubProjects(home: string): Promise<GameProject[]> {
  const files = [
    join(process.env.APPDATA ?? join(home, "AppData", "Roaming"), "UnityHub", "projects-v1.json"),
    join(home, "Library", "Application Support", "UnityHub", "projects-v1.json"),
    join(home, ".config", "UnityHub", "projects-v1.json"),
  ];
  for (const f of files) {
    const raw = await readFile(f, "utf8").catch(() => "");
    if (!raw) continue;
    try {
      const j = JSON.parse(raw) as { data?: Record<string, { path?: string; title?: string; version?: string }> };
      return Object.values(j.data ?? {})
        .filter((p) => typeof p.path === "string")
        .map((p) => ({ kind: "unity" as const, name: p.title || basename(p.path!), path: resolve(p.path!), ...(p.version ? { engine: p.version } : {}) }));
    } catch {
      return [];
    }
  }
  return [];
}

/**
 * The Unity and Unreal projects KesherAI can offer for a chat (the + menu →
 * Project, also from the phone): Unity projects added to KesherAI and those in
 * Unity Hub's list; Unreal projects in the usual folders and the one open in
 * the connected editor. Only folders that still exist, newest first.
 *
 * @param extra.unity - Unity projects KesherAI already knows.
 * @param extra.unrealFile - The .uproject of the connected Unreal Editor.
 * @param extra.home - The home folder (tests).
 */
export async function findGameProjects(extra: { unity?: string[]; unrealFile?: string; godot?: string[]; home?: string } = {}): Promise<GameProject[]> {
  const home = extra.home ?? homedir();
  const found = new Map<string, GameProject & { at: number }>();
  const add = async (p: GameProject) => {
    const key = process.platform === "win32" ? p.path.toLowerCase() : p.path;
    if (found.has(key)) return;
    const s = await stat(p.path).catch(() => undefined);
    if (!s?.isDirectory()) return;
    found.set(key, { ...p, at: s.mtimeMs });
  };
  // The version from the project itself when Unity Hub does not say it (projects added to KesherAI, older Hub lists).
  for (const u of extra.unity ?? []) if (isUnity(u)) await add({ kind: "unity", name: basename(u), path: resolve(u), ...(await unityVersion(u)) });
  for (const u of await unityHubProjects(home)) if (isUnity(u.path)) await add(u.engine ? u : { ...u, ...(await unityVersion(u.path)) });
  // Unity projects Unity Hub does not list: the usual places, two folder levels deep (like Unreal's "Unreal Projects").
  for (const dir of await unityFolders(home)) await add({ kind: "unity", name: basename(dir), path: resolve(dir), ...(await unityVersion(dir)) });
  // Godot: the projects KesherAI knows (the connected one), the project manager's list, and the usual folders.
  for (const g of [...(extra.godot ?? []), ...(await godotManagerProjects(home)), ...(await projectFolders(home, isGodot))]) if (isGodot(g)) await add({ kind: "godot", name: basename(g), path: resolve(g), ...(await godotVersion(g)) });
  const unreal = new Set<string>();
  if (extra.unrealFile) unreal.add(dirname(extra.unrealFile));
  for (const root of [join(home, "Documents", "Unreal Projects"), join(home, "Unreal Projects"), join(home, "OneDrive", "Documents", "Unreal Projects")]) {
    for (const d of await readdir(root, { withFileTypes: true }).catch(() => [])) if (d.isDirectory()) unreal.add(join(root, d.name));
  }
  for (const dir of unreal) {
    const p = await readProject(dir).catch(() => undefined);
    if (p) await add({ kind: "unreal", name: basename(p.file, ".uproject"), path: resolve(p.dir), ...(p.engine ? { engine: p.engine } : {}) });
  }
  return [...found.values()].sort((a, b) => b.at - a.at).slice(0, 60).map(({ at: _at, ...p }) => p);
}

/** Where people keep Unity projects (checked two levels deep). */
const UNITY_ROOTS = ["Unity Projects", "UnityProjects", "Documents", join("Documents", "Unity Projects"), join("source", "repos"), "repos", "Projects", "Desktop", "dev", "Dev", "GitHub", join("Documents", "GitHub"), join("OneDrive", "Documents")];

/**
 * Unity projects in the usual folders (a folder with Assets/ and
 * ProjectSettings/), two levels deep, at most 3,000 folders looked at.
 *
 * @param home - The home folder.
 */
export async function unityFolders(home: string): Promise<string[]> {
  return projectFolders(home, isUnity);
}

/**
 * Game projects of one engine in the usual folders, two levels deep, at most 3,000 folders looked at.
 *
 * @param home - The home folder.
 * @param is - Whether a folder is such a project.
 * @returns Their folders.
 */
async function projectFolders(home: string, is: (dir: string) => boolean): Promise<string[]> {
  const out: string[] = [];
  let seen = 0;
  const look = async (dir: string, depth: number) => {
    for (const d of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (!d.isDirectory() || d.name.startsWith(".") || /^(node_modules|Library|Temp|Logs|obj|Builds?|AppData)$/i.test(d.name) || ++seen > 3000) continue;
      const full = join(dir, d.name);
      if (is(full)) out.push(full);
      else if (depth > 1) await look(full, depth - 1);
    }
  };
  for (const r of UNITY_ROOTS) await look(join(home, r), 2);
  return out;
}

/** The Godot version a project was saved with (project.godot's config/features, e.g. "4.6"). */
async function godotVersion(dir: string): Promise<{ engine?: string }> {
  const t = await readFile(join(dir, "project.godot"), "utf8").catch(() => "");
  const v = /config\/features=PackedStringArray\("(\d+\.\d+)/.exec(t)?.[1];
  return v ? { engine: `Godot ${v}` } : {};
}

/** The editor version a Unity project was made with (ProjectSettings/ProjectVersion.txt). */
async function unityVersion(dir: string): Promise<{ engine?: string }> {
  const v = await readUnityVersion(dir);
  return v ? { engine: v } : {};
}

/** File types a chat can attach as "a script". */
const SCRIPT = /\.(cs|cpp|cc|h|hpp|inl|py|js|ts|lua|shader|hlsl|cginc|compute|usf|ush|uxml|uss|ini|json|asmdef|build\.cs|target\.cs|uplugin|uproject|verse|md)$/i;
/** Folders that hold the engines' generated files, never the user's scripts. */
const SKIP = new Set(["library", "temp", "obj", "logs", "intermediate", "binaries", "saved", "deriveddatacache", "node_modules", ".git", ".vs", ".idea", "build", "builds", "packagecache", ".vscode", "userSettings".toLowerCase()]);

/**
 * Finds scripts in the folders a chat may use, by part of the name or path
 * ("player", "Scripts/Enemy", "door.cpp"). Generated folders are skipped.
 *
 * @param roots - The chat's folders (its workspace and the projects/files given to it).
 * @param query - Part of a file name or path; empty lists recent scripts.
 * @param max - How many to return.
 * @returns Absolute paths, best matches first, with the root they are in.
 */
export async function findScripts(roots: string[], query: string, max = 40): Promise<Array<{ path: string; rel: string; root: string }>> {
  const q = query.trim().toLowerCase().replace(/\\/g, "/");
  const hits: Array<{ path: string; rel: string; root: string; score: number; at: number }> = [];
  let seen = 0;
  for (const root of roots) {
    const rs = await stat(root).catch(() => undefined);
    if (!rs) continue;
    if (rs.isFile()) {
      if (SCRIPT.test(root) && (!q || root.toLowerCase().includes(q))) hits.push({ path: root, rel: basename(root), root: dirname(root), score: 1, at: rs.mtimeMs });
      continue;
    }
    const stack = [root];
    while (stack.length && seen < 30_000) {
      const dir = stack.pop()!;
      for (const d of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
        seen++;
        if (d.isDirectory()) {
          if (!SKIP.has(d.name.toLowerCase()) && !d.name.startsWith(".")) stack.push(join(dir, d.name));
          continue;
        }
        if (!d.isFile() || !SCRIPT.test(d.name)) continue;
        const full = join(dir, d.name);
        const rel = relative(root, full).split(sep).join("/");
        const name = d.name.toLowerCase();
        const score = !q ? 1 : name === q ? 4 : name.startsWith(q) ? 3 : name.includes(q) ? 2 : rel.toLowerCase().includes(q) ? 1 : 0;
        if (!score) continue;
        hits.push({ path: full, rel, root, score, at: 0 });
      }
    }
  }
  if (!q) {
    // No words yet: the most recently changed scripts.
    await Promise.all(hits.slice(0, 3000).map(async (h) => (h.at = (await stat(h.path).catch(() => undefined))?.mtimeMs ?? 0)));
    hits.sort((a, b) => b.at - a.at);
  } else hits.sort((a, b) => b.score - a.score || a.rel.length - b.rel.length);
  return hits.slice(0, max).map(({ path, rel, root }) => ({ path, rel, root }));
}

/** Folders under Assets that hold no scripts worth showing (generated or huge). */
const NOT_SCRIPTS = /^(\..*|StreamingAssets|AddressableAssetsData|Gizmos)$/i;

/**
 * The C# scripts of a Unity project (under Assets/, Plugins included), up to
 * 3,000, breadth first with the folders most likely to hold the user's own
 * code (Scripts, Code, Source, _Project, Game…) looked at first, so big asset
 * packs never use up the search before the user's scripts are reached.
 *
 * @param project - The Unity project folder.
 * @returns The scripts' project paths, how many folders were looked at, and whether it stopped early.
 */
export async function listUnityScripts(project: string): Promise<{ scripts: string[]; folders: number; partial: boolean }> {
  const root = join(project, "Assets");
  const out: string[] = [];
  const likely = (n: string) => /^(_?scripts?|code|source|src|_?project|game|gameplay|runtime|editor)$/i.test(n);
  const queue: string[] = [root];
  let folders = 0;
  let entries = 0;
  while (queue.length && out.length < 3000 && entries < 400_000) {
    const dir = queue.shift()!;
    folders++;
    const list = await readdir(dir, { withFileTypes: true }).catch(() => []);
    const subs: string[] = [];
    for (const e of list) {
      entries++;
      if (e.isDirectory()) {
        if (!NOT_SCRIPTS.test(e.name)) subs.push(e.name);
      } else if (e.name.endsWith(".cs")) out.push(relative(project, join(dir, e.name)).replace(/\\/g, "/"));
    }
    // Likely code folders go to the front of the queue.
    subs.sort((a, b) => Number(likely(b)) - Number(likely(a)));
    const front = subs.filter(likely).map((n) => join(dir, n));
    const back = subs.filter((n) => !likely(n)).map((n) => join(dir, n));
    queue.unshift(...front);
    queue.push(...back);
  }
  return { scripts: out.sort(), folders, partial: queue.length > 0 };
}

/** One entry of the Unity page's project menu. */
export interface UnityMenuItem {
  name: string;
  path: string;
  /** The Unity version (project's own or Unity Hub's), when known. */
  engine?: string;
  /** Added to KesherAI (the rest of the page works on it); false = found on the computer only. */
  added: boolean;
  /** The project the page works on now. */
  active: boolean;
  /** The two folders above the project (e.g. "OneDrive › GitHub"), only when another project has the same name. */
  parent?: string;
}

/**
 * The Unity page's project menu: every Unity project on the computer (the found ones, plus added ones that
 * are not found any more), once each, the added ones marked. Projects with the same name in two folders
 * (e.g. Documents and OneDrive copies) get a short parent label so they can be told apart.
 *
 * @param found - Unity projects found on the computer (findGameProjects, Unity only).
 * @param added - The project folders added to KesherAI.
 * @param active - The project the page works on now.
 * @returns The menu, added ones first, then by name.
 */
export function unityProjectMenu(found: GameProject[], added: string[], active?: string): UnityMenuItem[] {
  const norm = (p: string) => (process.platform === "win32" ? resolve(p).toLowerCase() : resolve(p));
  const addedSet = new Set(added.map(norm));
  const items = new Map<string, UnityMenuItem>();
  for (const p of found) {
    if (p.kind !== "unity" || items.has(norm(p.path))) continue;
    items.set(norm(p.path), { name: p.name, path: p.path, ...(p.engine ? { engine: p.engine } : {}), added: addedSet.has(norm(p.path)), active: !!active && norm(active) === norm(p.path) });
  }
  for (const a of added) if (!items.has(norm(a))) items.set(norm(a), { name: basename(a), path: a, added: true, active: !!active && norm(active) === norm(a) });
  const list = [...items.values()];
  const count = new Map<string, number>();
  for (const i of list) count.set(i.name.toLowerCase(), (count.get(i.name.toLowerCase()) ?? 0) + 1);
  for (const i of list) {
    if ((count.get(i.name.toLowerCase()) ?? 0) < 2) continue;
    i.parent = dirname(i.path).split(/[\\/]/).filter(Boolean).slice(-2).join(" › ");
  }
  return list.sort((a, b) => Number(b.added) - Number(a.added) || a.name.localeCompare(b.name));
}

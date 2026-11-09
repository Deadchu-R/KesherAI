import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { readProject } from "./unreal-install.js";

/** A Unity or Unreal project found on this computer. */
export interface GameProject {
  kind: "unity" | "unreal";
  name: string;
  path: string;
  engine?: string;
}

const isUnity = (dir: string) => existsSync(join(dir, "Assets")) && existsSync(join(dir, "ProjectSettings"));

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
export async function findGameProjects(extra: { unity?: string[]; unrealFile?: string; home?: string } = {}): Promise<GameProject[]> {
  const home = extra.home ?? homedir();
  const found = new Map<string, GameProject & { at: number }>();
  const add = async (p: GameProject) => {
    const key = process.platform === "win32" ? p.path.toLowerCase() : p.path;
    if (found.has(key)) return;
    const s = await stat(p.path).catch(() => undefined);
    if (!s?.isDirectory()) return;
    found.set(key, { ...p, at: s.mtimeMs });
  };
  for (const u of extra.unity ?? []) if (isUnity(u)) await add({ kind: "unity", name: basename(u), path: resolve(u) });
  for (const u of await unityHubProjects(home)) if (isUnity(u.path)) await add(u);
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

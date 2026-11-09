import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, normalize, sep } from "node:path";
import { unzipSync } from "fflate";
import type { Knowledge } from "./knowledge.js";

/**
 * The library store: documentation and reference code downloaded once to
 * this computer, so the models (and the user) work from it with no internet.
 *
 * How others do it (researched first): Zeal and Dash download "docsets"
 * (versioned archives with a search index) from a catalog and update them
 * as a whole; @neuledge/context builds versioned packages from a git
 * repository's docs at an exact tag, keeps them in a local folder and
 * searches them with full-text search, offline, for coding agents; Context7
 * does the same in the cloud. KesherAI follows the local way: a catalog of
 * libraries, each from a fixed source and version, unpacked to
 * ~/.kesher/libraries/<id>/ and added as a knowledge base (BM25 search,
 * and meaning search when the embedding model is on), which the models
 * already search with search_knowledge. Engines installed on this computer
 * (Unreal's headers) are added from their own folder with no download.
 *
 * Safety: only https sources; archive paths are checked so nothing is
 * written outside the library's folder; only text documentation and source
 * files are kept (no programs).
 */

/** Where a library comes from. */
export type LibrarySource =
  /** A GitHub repository at a branch or tag; `paths` are the folders kept. */
  | { kind: "github"; repo: string; ref: string; paths: string[] }
  /** A zip archive on the web; `paths` are the folders kept ("" = all). */
  | { kind: "zip"; url: string; paths: string[] }
  /** Folders already on this computer (an installed engine's sources). */
  | { kind: "local"; find: () => Promise<string[] | undefined> };

/** A library in the store. */
export interface CatalogEntry {
  id: string;
  name: string;
  description: string;
  category: "engine" | "language" | "web" | "ai" | "custom";
  version: string;
  /** About how big the download is, in MB (0 = nothing to download). */
  sizeMb: number;
  source: LibrarySource;
}

/** An installed library. */
export interface InstalledLibrary {
  id: string;
  name: string;
  version: string;
  /** Where its files are (several for a library read in place). */
  folders: string[];
  files: number;
  bytes: number;
  baseId: string;
  installedAt: string;
}

/** Files kept from an archive: documentation and source text, no programs. */
const KEEP = /\.(md|mdx|markdown|rst|txt|html?|cs|h|hpp|cpp|py|gd|ts|js|json|ya?ml|ini|xml)$/i;
const MAX_ARCHIVE = 400 * 1024 * 1024;

/**
 * The built-in catalog. Sources are fixed versions, so a library is the same
 * on every computer. `unrealHeaders` finds an installed engine.
 */
export function catalog(unrealHeaders: () => Promise<string[] | undefined>): CatalogEntry[] {
  return [
    { id: "unreal-api-local", name: "Unreal Engine C++ API (installed engine)", description: "The engine's own headers with their documentation comments (Engine, Core, GameFramework…), read from the Unreal you have installed. No download.", category: "engine", version: "installed", sizeMb: 0, source: { kind: "local", find: unrealHeaders } },
    { id: "unity-cs-reference", name: "Unity C# reference source", description: "Unity's C# engine and editor source as published by Unity (UnityCsReference), for how the API really behaves.", category: "engine", version: "6000.3", sizeMb: 60, source: { kind: "github", repo: "Unity-Technologies/UnityCsReference", ref: "refs/heads/6000.3/staging", paths: ["Runtime", "Editor/Mono"] } },
    { id: "godot-docs", name: "Godot documentation", description: "The full Godot manual and class reference (stable).", category: "engine", version: "stable", sizeMb: 140, source: { kind: "github", repo: "godotengine/godot-docs", ref: "refs/heads/stable", paths: ["about", "getting_started", "tutorials", "classes"] } },
    { id: "python-docs", name: "Python 3.13 documentation", description: "The Python language and standard library documentation, as text.", category: "language", version: "3.13", sizeMb: 10, source: { kind: "zip", url: "https://docs.python.org/3.13/archives/python-3.13-docs-text.zip", paths: [""] } },
    { id: "react-docs", name: "React documentation", description: "react.dev: learn and API reference.", category: "web", version: "main", sizeMb: 40, source: { kind: "github", repo: "reactjs/react.dev", ref: "refs/heads/main", paths: ["src/content"] } },
    { id: "typescript-handbook", name: "TypeScript handbook", description: "The TypeScript handbook and reference.", category: "language", version: "v2", sizeMb: 30, source: { kind: "github", repo: "microsoft/TypeScript-Website", ref: "refs/heads/v2", paths: ["packages/documentation/copy/en"] } },
  ];
}

/** GitHub's archive address for a repository at a ref ("refs/heads/x" or "refs/tags/v1"). */
export function githubZipUrl(repo: string, ref: string): string {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error("A GitHub repository looks like owner/name.");
  if (!/^refs\/(heads|tags)\/[\w./-]+$/.test(ref) || ref.includes("..")) throw new Error("A ref looks like refs/heads/main or refs/tags/v1.0.");
  return `https://codeload.github.com/${repo}/zip/${ref}`;
}

/**
 * The files of an archive to keep: under one of `paths` (relative to the
 * archive's single top folder for GitHub archives), text documentation only,
 * and never outside the target folder.
 *
 * @returns Relative path (inside the library folder) → content.
 */
export function pickFiles(files: Record<string, Uint8Array>, paths: string[], stripTop: boolean): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  const wanted = paths.map((p) => p.replace(/\\/g, "/").replace(/^\/+|\/+$/g, ""));
  for (const [name, data] of Object.entries(files)) {
    if (name.endsWith("/") || !KEEP.test(name)) continue;
    let rel = name.replace(/\\/g, "/");
    if (stripTop) rel = rel.slice(rel.indexOf("/") + 1);
    if (!wanted.some((w) => w === "" || rel === w || rel.startsWith(`${w}/`))) continue;
    const clean = normalize(rel);
    if (!clean || clean.startsWith("..") || clean.startsWith(sep) || /^[A-Za-z]:/.test(clean) || clean.split(/[\\/]/).includes("..")) continue;
    out.set(clean, data);
  }
  return out;
}

/** The library store: install, list and remove. */
export class Libraries {
  private installing = new Map<string, Promise<InstalledLibrary>>();
  /** The last failed install of each library, shown on the page until it is tried again. */
  private errors = new Map<string, string>();

  /**
   * @param dir - ~/.kesher/libraries.
   * @param knowledge - Where each library becomes a searchable base.
   * @param unrealHeaders - Finds an installed Unreal Engine's Source folder.
   * @param fetchImpl - For tests.
   */
  constructor(
    private readonly dir: string,
    private readonly knowledge: Knowledge,
    private readonly unrealHeaders: () => Promise<string[] | undefined>,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async installed(): Promise<InstalledLibrary[]> {
    try {
      return JSON.parse(await readFile(join(this.dir, "installed.json"), "utf8")) as InstalledLibrary[];
    } catch {
      return [];
    }
  }

  private async saveInstalled(list: InstalledLibrary[]): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await writeFile(join(this.dir, "installed.json"), JSON.stringify(list, null, 2));
  }

  /** @returns The catalog with what is installed, and what is installing now. */
  async list() {
    const inst = await this.installed();
    return {
      catalog: catalog(this.unrealHeaders).map(({ source, ...e }) => ({ ...e, local: source.kind === "local", installed: inst.find((i) => i.id === e.id) ?? null, installing: this.installing.has(e.id), error: this.errors.get(e.id) ?? null })),
      custom: inst.filter((i) => !catalog(this.unrealHeaders).some((c) => c.id === i.id)),
    };
  }

  /**
   * Installs a library from the catalog, or a custom one (a GitHub
   * repository at a ref and folder). Downloads once, unpacks the
   * documentation, and adds it as a knowledge base.
   */
  install(idOrCustom: string | { name: string; repo: string; ref: string; path?: string }): Promise<InstalledLibrary> {
    const entry: CatalogEntry | undefined =
      typeof idOrCustom === "string"
        ? catalog(this.unrealHeaders).find((c) => c.id === idOrCustom)
        : {
            id: `custom-${idOrCustom.repo.replace(/[^\w-]+/g, "-").toLowerCase()}`.slice(0, 80),
            name: idOrCustom.name.trim().slice(0, 80) || idOrCustom.repo,
            description: `${idOrCustom.repo} (${idOrCustom.ref})`,
            category: "custom",
            version: idOrCustom.ref.replace(/^refs\/(heads|tags)\//, ""),
            sizeMb: 0,
            source: { kind: "github", repo: idOrCustom.repo, ref: idOrCustom.ref, paths: [idOrCustom.path ?? ""] },
          };
    if (!entry) return Promise.reject(new Error("No such library in the store."));
    const busy = this.installing.get(entry.id);
    if (busy) return busy;
    this.errors.delete(entry.id);
    const job = this.doInstall(entry)
      .catch((err: Error) => {
        this.errors.set(entry.id, err.message);
        throw err;
      })
      .finally(() => this.installing.delete(entry.id));
    this.installing.set(entry.id, job);
    return job;
  }

  private async doInstall(e: CatalogEntry): Promise<InstalledLibrary> {
    let folders: string[];
    let files = 0;
    let bytes = 0;
    if (e.source.kind === "local") {
      const found = await e.source.find();
      if (!found?.length) throw new Error("No installed Unreal Engine was found on this computer.");
      folders = found;
      for (const f of found) {
        const c = await countFiles(f);
        files += c.files;
        bytes += c.bytes;
      }
    } else {
      const url = e.source.kind === "github" ? githubZipUrl(e.source.repo, e.source.ref) : e.source.url;
      if (!/^https:\/\//.test(url)) throw new Error("Libraries are downloaded over https only.");
      const res = await this.fetchImpl(url, { headers: { "user-agent": "KesherAI" }, signal: AbortSignal.timeout(30 * 60_000) });
      if (!res.ok) throw new Error(`The download failed: the server answered ${res.status}.`);
      const size = Number(res.headers.get("content-length") ?? 0);
      if (size > MAX_ARCHIVE) throw new Error(`The archive is ${Math.round(size / 1048576)} MB, more than the ${MAX_ARCHIVE / 1048576} MB limit.`);
      const buf = new Uint8Array(await res.arrayBuffer());
      if (buf.length > MAX_ARCHIVE) throw new Error("The archive is too big.");
      const picked = pickFiles(unzipSync(buf, { filter: (f) => KEEP.test(f.name) }), e.source.paths, e.source.kind === "github");
      if (!picked.size) throw new Error("The archive had no documentation in the expected folders.");
      const folder = join(this.dir, e.id);
      folders = [folder];
      await rm(folder, { recursive: true, force: true });
      for (const [rel, data] of picked) {
        const target = join(folder, rel);
        if (!target.startsWith(folder + sep)) continue;
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, data);
        files++;
        bytes += data.length;
      }
    }
    const list = await this.installed();
    const old = list.find((i) => i.id === e.id);
    const base = await this.knowledge.save({ ...(old ? { id: old.baseId } : {}), name: `Library: ${e.name}`, description: `${e.description} Version ${e.version}, on this computer (works offline).`, folders, urls: [] });
    const lib: InstalledLibrary = { id: e.id, name: e.name, version: e.version, folders, files, bytes, baseId: base.id, installedAt: new Date().toISOString() };
    await this.saveInstalled([...list.filter((i) => i.id !== e.id), lib]);
    return lib;
  }

  /** Removes a library: its knowledge base, and its files when KesherAI downloaded them (never an engine's own folder). */
  async remove(id: string): Promise<void> {
    const list = await this.installed();
    const lib = list.find((i) => i.id === id);
    if (!lib) return;
    await this.knowledge.remove(lib.baseId);
    for (const f of lib.folders) if (f.startsWith(join(this.dir) + sep) && existsSync(f)) await rm(f, { recursive: true, force: true });
    await this.saveInstalled(list.filter((i) => i.id !== id));
  }
}

/** Counts the documentation files under a folder (for a library read in place). */
async function countFiles(dir: string): Promise<{ files: number; bytes: number }> {
  let files = 0;
  let bytes = 0;
  const walk = async (d: string, depth: number) => {
    for (const x of await readdir(d, { withFileTypes: true }).catch(() => [])) {
      const p = join(d, x.name);
      if (x.isDirectory() && depth < 12) await walk(p, depth + 1);
      else if (x.isFile() && KEEP.test(x.name)) {
        files++;
        bytes += (await stat(p).catch(() => ({ size: 0 }))).size;
      }
    }
  };
  await walk(dir, 0);
  return { files, bytes };
}

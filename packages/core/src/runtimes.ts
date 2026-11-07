import { readdir, rm, stat } from "node:fs/promises";
import { delimiter, join } from "node:path";
import type { DownloadManager } from "@kesher/downloads";
import { extractArchive, waitForDownload } from "./llamacpp.js";

/**
 * Programs that MCP servers need (Node.js for `npx` servers, uv for `uvx`
 * servers), downloaded by KesherAI into its own folder when the user clicks
 * "Install" — no administrator rights and nothing changed on the computer.
 * KesherAI adds them to the PATH of the servers it starts.
 */

/** A program KesherAI can install for MCP servers. */
export type Runtime = "node" | "uv";

/** Where a runtime's download comes from, for this system. */
export interface RuntimeDownload {
  url: string;
  file: string;
  size?: number;
  version: string;
}

const NODE_DIST = "https://nodejs.org/dist";

/**
 * Picks this system's Node.js LTS download from nodejs.org's index.
 *
 * @param index - nodejs.org/dist/index.json.
 * @param platform - `win32`, `darwin` or `linux`.
 * @param arch - `x64` or `arm64`.
 * @returns The download.
 */
export function nodeDownload(index: Array<{ version: string; lts: string | false; files: string[] }>, platform = process.platform, arch = process.arch): RuntimeDownload | undefined {
  const a = arch === "arm64" ? "arm64" : "x64";
  const want = platform === "win32" ? `win-${a}-zip` : platform === "darwin" ? `osx-${a}-tar` : `linux-${a}`;
  const rel = index.find((r) => r.lts && r.files.includes(want));
  if (!rel) return undefined;
  const name = platform === "win32" ? `node-${rel.version}-win-${a}.zip` : platform === "darwin" ? `node-${rel.version}-darwin-${a}.tar.gz` : `node-${rel.version}-linux-${a}.tar.gz`;
  return { url: `${NODE_DIST}/${rel.version}/${name}`, file: name, version: rel.version };
}

/**
 * Picks this system's uv download from a GitHub release.
 *
 * @param assets - The release's files.
 * @param platform - `win32`, `darwin` or `linux`.
 * @param arch - `x64` or `arm64`.
 * @returns The file, if there is one.
 */
export function uvAsset<T extends { name: string }>(assets: T[], platform = process.platform, arch = process.arch): T | undefined {
  const cpu = arch === "arm64" ? "aarch64" : "x86_64";
  const target = platform === "win32" ? `uv-${cpu}-pc-windows-msvc.zip` : platform === "darwin" ? `uv-${cpu}-apple-darwin.tar.gz` : `uv-${cpu}-unknown-linux-gnu.tar.gz`;
  return assets.find((a) => a.name === target);
}

/** Installs and finds Node.js and uv for MCP servers. */
export class Runtimes {
  private installing = new Map<Runtime, Promise<void>>();
  private errors = new Map<Runtime, string>();

  /**
   * @param dir - KesherAI's own folder for them (inside the engines folder).
   * @param downloads - The download queue (shown in the downloads circle).
   */
  constructor(
    private readonly dir: string,
    private readonly downloads: DownloadManager,
  ) {}

  /** Folders that hold a runtime's programs (`npx`, `uvx`). */
  private async binDirs(tool: Runtime): Promise<string[]> {
    const root = join(this.dir, tool);
    const out: string[] = [];
    const walk = async (d: string, depth: number) => {
      const entries = await readdir(d, { withFileTypes: true }).catch(() => []);
      const names = entries.map((e) => e.name.toLowerCase());
      const marker = tool === "node" ? ["npx.cmd", "npx"] : ["uvx.exe", "uvx"];
      if (names.some((n) => marker.includes(n))) out.push(d);
      if (depth < 3) for (const e of entries) if (e.isDirectory()) await walk(join(d, e.name), depth + 1);
    };
    await walk(root, 0);
    return out;
  }

  /** @returns PATH folders to add for servers KesherAI starts. */
  async paths(): Promise<string[]> {
    return [...(await this.binDirs("node")), ...(await this.binDirs("uv"))];
  }

  /**
   * Builds a server's environment with KesherAI's runtimes first on PATH.
   *
   * @param env - The environment to start from.
   * @returns The environment.
   */
  async env(env: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv> {
    const extra = await this.paths();
    if (!extra.length) return env;
    // Windows calls it "Path"; keep whichever spelling is there.
    const key = Object.keys(env).find((k) => k.toLowerCase() === "path") ?? "PATH";
    return { ...env, [key]: [...extra, env[key] ?? ""].filter(Boolean).join(delimiter) };
  }

  /** @returns What is installed and what is happening. */
  async status(): Promise<Record<Runtime, { installed: boolean; busy: boolean; error?: string }>> {
    const one = async (t: Runtime) => ({ installed: (await this.binDirs(t)).length > 0, busy: this.installing.has(t), ...(this.errors.get(t) ? { error: this.errors.get(t)! } : {}) });
    return { node: await one("node"), uv: await one("uv") };
  }

  /**
   * Downloads and unpacks a runtime (once; later calls wait for the same work).
   *
   * @param tool - `node` or `uv`.
   */
  install(tool: Runtime): Promise<void> {
    const running = this.installing.get(tool);
    if (running) return running;
    const p = (async () => {
      this.errors.delete(tool);
      if ((await this.binDirs(tool)).length) return;
      let d: RuntimeDownload | undefined;
      if (tool === "node") {
        const res = await fetch(`${NODE_DIST}/index.json`, { signal: AbortSignal.timeout(30_000) });
        if (!res.ok) throw new Error(`nodejs.org answered ${res.status}.`);
        d = nodeDownload((await res.json()) as Array<{ version: string; lts: string | false; files: string[] }>);
      } else {
        const res = await fetch("https://api.github.com/repos/astral-sh/uv/releases/latest", { headers: { accept: "application/vnd.github+json", "user-agent": "KesherAI" }, signal: AbortSignal.timeout(30_000) });
        if (!res.ok) throw new Error(`GitHub answered ${res.status} while looking for uv.`);
        const rel = (await res.json()) as { tag_name: string; assets: Array<{ name: string; browser_download_url: string; size: number }> };
        const a = uvAsset(rel.assets);
        if (a) d = { url: a.browser_download_url, file: a.name, size: a.size, version: rel.tag_name };
      }
      if (!d) throw new Error(`There is no ${tool === "node" ? "Node.js" : "uv"} download for this computer.`);
      const folder = join(this.dir, tool);
      const archive = join(this.dir, d.file);
      const job = this.downloads.enqueue({ url: d.url, dest: archive, ...(d.size ? { size: d.size } : {}), label: `${tool === "node" ? "Node.js" : "uv"} ${d.version} (for MCP servers)` });
      await waitForDownload(this.downloads, job.id);
      await extractArchive(archive, folder);
      await rm(archive, { force: true });
      if (!(await this.binDirs(tool)).length) throw new Error(`The ${tool} download did not contain the expected programs.`);
    })()
      .catch((err: Error) => {
        this.errors.set(tool, err.message);
        throw err;
      })
      .finally(() => this.installing.delete(tool));
    this.installing.set(tool, p);
    return p;
  }

  /** @returns Whether the runtimes folder exists at all (for tests). */
  async present(): Promise<boolean> {
    return !!(await stat(this.dir).catch(() => undefined));
  }
}

import { existsSync } from "node:fs";
import { cp, mkdir, readFile, readdir, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

/**
 * The Unreal plugins a project uses and the engines have, and moving a
 * plugin to another engine version.
 *
 * How others do it (researched first): the Epic Games Launcher lists each
 * engine's "Installed Plugins" (from Fab/Marketplace) and installs a
 * plugin's build for one engine version at a time; Unreal itself reads each
 * plugin's .uplugin (VersionName, EngineVersion) and offers to rebuild a
 * project's plugins when the engine changes; plugin authors port with
 * `RunUAT BuildPlugin -Plugin=… -Package=…` against the new engine, fixing
 * what no longer compiles. KesherAI lists them all from the .uplugin files,
 * and ports a plugin that has its source the way authors do: BuildPlugin
 * with the target engine, the compiler's errors back to the model when it
 * fails, and the built plugin copied in (the old one kept as a backup).
 */

/** One plugin found. */
export interface UnrealPlugin {
  name: string;
  /** Where it was found: the project, the engine's Marketplace/Fab folder, or the engine itself. */
  where: "project" | "marketplace" | "engine";
  path: string;
  version?: string;
  /** The engine version it says it was built for (Marketplace/Fab plugins). */
  engineVersion?: string;
  friendlyName?: string;
  /** It has its C++ source (so it can be rebuilt for another engine version). */
  hasSource: boolean;
  /** It has built Windows binaries. */
  hasBinaries: boolean;
  /** For project-level listing: enabled in the .uproject (undefined: not listed there). */
  enabled?: boolean;
}

/** Finds .uplugin files under a folder (a few levels deep; skips build output). */
async function findUplugins(root: string, depth = 4): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string, d: number) => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const own = entries.find((e) => e.isFile() && e.name.toLowerCase().endsWith(".uplugin"));
    if (own) {
      out.push(join(dir, own.name));
      return; // a plugin's own folders hold no other plugins worth listing
    }
    if (d <= 0) return;
    for (const e of entries) if (e.isDirectory() && !/^(Binaries|Intermediate|Saved|Source|Content|Resources|\.git)$/i.test(e.name)) await walk(join(dir, e.name), d - 1);
  };
  await walk(root, depth);
  return out;
}

/** Reads one plugin. */
export async function readPlugin(file: string, where: UnrealPlugin["where"]): Promise<UnrealPlugin | undefined> {
  try {
    const j = JSON.parse((await readFile(file, "utf8")).replace(/^\uFEFF/, "")) as { VersionName?: string; EngineVersion?: string; FriendlyName?: string };
    const dir = dirname(file);
    return {
      name: basename(file).replace(/\.uplugin$/i, ""),
      where,
      path: dir,
      ...(j.VersionName ? { version: String(j.VersionName) } : {}),
      ...(j.EngineVersion ? { engineVersion: String(j.EngineVersion) } : {}),
      ...(j.FriendlyName ? { friendlyName: String(j.FriendlyName) } : {}),
      hasSource: existsSync(join(dir, "Source")),
      hasBinaries: existsSync(join(dir, "Binaries", "Win64")),
    };
  } catch {
    return undefined;
  }
}

/**
 * The plugins of a project (its Plugins folder, plus what its .uproject
 * turns on) and of an engine's Marketplace/Fab folder.
 */
export async function listPlugins(opts: { projectDir?: string; uproject?: string; enginePath?: string; includeEngine?: boolean }): Promise<UnrealPlugin[]> {
  const out: UnrealPlugin[] = [];
  const enabled = new Map<string, boolean>();
  if (opts.uproject) {
    try {
      const j = JSON.parse((await readFile(opts.uproject, "utf8")).replace(/^\uFEFF/, "")) as { Plugins?: Array<{ Name?: string; Enabled?: boolean }> };
      for (const p of j.Plugins ?? []) if (p?.Name) enabled.set(p.Name, p.Enabled !== false);
    } catch {
      // unreadable .uproject: no enabled list
    }
  }
  if (opts.projectDir) for (const f of await findUplugins(join(opts.projectDir, "Plugins"))) {
    const p = await readPlugin(f, "project");
    if (p) out.push({ ...p, ...(enabled.has(p.name) ? { enabled: enabled.get(p.name) } : {}) });
  }
  if (opts.enginePath) {
    for (const sub of ["Marketplace", "Fab"]) for (const f of await findUplugins(join(opts.enginePath, "Engine", "Plugins", sub))) {
      const p = await readPlugin(f, "marketplace");
      if (p) out.push({ ...p, ...(enabled.has(p.name) ? { enabled: enabled.get(p.name) } : {}) });
    }
    // Engine plugins the project turns on by name (Epic's own): listed briefly, they come with the engine.
    if (opts.includeEngine) for (const [name, on] of enabled) {
      if (out.some((p) => p.name === name)) continue;
      out.push({ name, where: "engine", path: "", hasSource: false, hasBinaries: true, enabled: on });
    }
  }
  return out;
}

/** One line per plugin, for the model and the user. */
export function describePlugins(list: UnrealPlugin[], engine?: string): string {
  if (!list.length) return "No plugins found.";
  const line = (p: UnrealPlugin) => {
    const bits = [p.version ? `v${p.version}` : "", p.engineVersion ? `built for UE ${p.engineVersion}${engine && !p.engineVersion.startsWith(engine.split(".").slice(0, 2).join(".")) ? ` ⚠ not ${engine}` : ""}` : "", p.enabled === undefined ? "" : p.enabled ? "on in the project" : "off in the project", p.where === "engine" ? "comes with the engine" : p.hasSource ? "has source (can be rebuilt for another engine)" : p.hasBinaries ? "built only (no source)" : "no build and no source"].filter(Boolean);
    return `- ${p.friendlyName ?? p.name} (${p.name}) — ${bits.join(", ")}${p.path ? `\n  ${p.path}` : ""}`;
  };
  const groups: Array<[UnrealPlugin["where"], string]> = [["project", "In the project's Plugins folder"], ["marketplace", "In the engine's Fab/Marketplace folder"], ["engine", "Epic's own, turned on in the .uproject"]];
  return groups.map(([w, title]) => [w, title, list.filter((p) => p.where === w)] as const).filter(([, , l]) => l.length).map(([, title, l]) => `${title}:\n${l.map(line).join("\n")}`).join("\n\n");
}

/** The compiler's own error lines from a build log (the lines worth showing). */
export function compileErrors(log: string, max = 12): string[] {
  return [...new Set(log.split(/\r?\n/).filter((l) => /\berror [A-Z]+\d+:|: fatal error|\): error|error: /.test(l)).map((l) => l.trim().replace(/^.*[\\/](Source[\\/])/, "$1")))].slice(0, max);
}

/**
 * Puts a built plugin in place of the old one: the old folder is renamed to
 * `<name>.kesher-backup-<time>` (nothing is deleted), then the built files
 * are copied in.
 *
 * @returns The backup folder, if there was an old one.
 */
export async function installBuiltPlugin(built: string, dest: string, keepSource: boolean): Promise<string | undefined> {
  let backup: string | undefined;
  if (existsSync(dest)) {
    backup = `${dest}.kesher-backup-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`;
    await rename(dest, backup);
  }
  await mkdir(dest, { recursive: true });
  for (const part of await readdir(built)) {
    if (/^(Intermediate|HostProject)$/i.test(part)) continue;
    if (!keepSource && /^Source$/i.test(part)) continue;
    await cp(join(built, part), join(dest, part), { recursive: true });
  }
  return backup;
}

/** Removes a failed build's folder. */
export async function removeBuild(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

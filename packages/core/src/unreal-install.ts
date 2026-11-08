import { spawn, execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, readdir, readFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Puts the KesherAI Bridge plugin into an Unreal project — also a
 * Blueprint-only one, with no C++ of its own.
 *
 * Unreal can load a plugin that already has its compiled files
 * (`Binaries/`) in any project of the same engine version. So KesherAI
 * builds the plugin once per engine version with the engine's own tool
 * (`RunUAT BuildPlugin`, which needs Visual Studio's C++ tools but not a C++
 * project), keeps the result, and copies it into the project's `Plugins`
 * folder without its source, so Unreal never asks to rebuild it.
 *
 * Windows only for now (where the Epic Games Launcher installs engines).
 */

/** An installed engine. */
export interface UnrealEngine {
  /** e.g. `5.4`, or the build id of a source build. */
  version: string;
  /** Its folder (the one that contains `Engine/`). */
  path: string;
  /** "launcher" or "source". */
  kind: "launcher" | "source";
}

/** The current install, shown on the Unreal page. */
export interface InstallJob {
  state: "building" | "copying" | "done" | "failed";
  project: string;
  engine: string;
  log: string[];
  message?: string;
}

/**
 * Engines installed by the Epic Games Launcher, from its list
 * (`%ProgramData%\Epic\UnrealEngineLauncher\LauncherInstalled.dat`).
 *
 * @param text - That file's text.
 * @returns The engines in it (UE_5.x only), newest first.
 */
export function launcherEngines(text: string): UnrealEngine[] {
  try {
    const j = JSON.parse(text) as { InstallationList?: Array<{ InstallLocation?: string; AppName?: string }> };
    return (j.InstallationList ?? [])
      .map((e) => ({ m: /^UE_(\d+\.\d+)$/.exec(e.AppName ?? ""), path: e.InstallLocation ?? "" }))
      .filter((e): e is { m: RegExpExecArray; path: string } => !!e.m && !!e.path)
      .map((e) => ({ version: e.m[1]!, path: e.path, kind: "launcher" as const }))
      .sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }));
  } catch {
    return [];
  }
}

/** Engines built from source, registered under HKCU\Software\Epic Games\Unreal Engine\Builds. */
async function sourceEngines(): Promise<UnrealEngine[]> {
  const out = await new Promise<string>((res) => execFile("reg", ["query", "HKCU\\Software\\Epic Games\\Unreal Engine\\Builds"], { windowsHide: true }, (_e, o) => res(o ?? "")));
  return out
    .split(/\r?\n/)
    .map((l) => /^\s+(\S+)\s+REG_SZ\s+(.+)$/.exec(l))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => ({ version: m[1]!, path: m[2]!.trim(), kind: "source" as const }));
}

/** @returns Every engine found on this computer. */
export async function findEngines(): Promise<UnrealEngine[]> {
  if (process.platform !== "win32") return [];
  const list = join(process.env.ProgramData ?? "C:\\ProgramData", "Epic", "UnrealEngineLauncher", "LauncherInstalled.dat");
  const launcher = launcherEngines(await readFile(list, "utf8").catch(() => ""));
  return [...launcher, ...(await sourceEngines().catch(() => []))].filter((e) => existsSync(join(e.path, "Engine", "Build", "BatchFiles", "RunUAT.bat")));
}

/**
 * Finds the project file in a folder and the engine it wants.
 *
 * @param folder - The project folder (or the .uproject file).
 * @returns Its .uproject path and `EngineAssociation` ("5.4", or a source build id).
 * @throws Error when the folder has no .uproject.
 */
export async function readProject(folder: string): Promise<{ file: string; dir: string; engine: string }> {
  const file = folder.toLowerCase().endsWith(".uproject") ? folder : (await readdir(folder).catch(() => [] as string[])).filter((f) => f.toLowerCase().endsWith(".uproject")).map((f) => join(folder, f))[0];
  if (!file || !existsSync(file)) throw new Error("No Unreal project (.uproject) in that folder.");
  const j = JSON.parse((await readFile(file, "utf8")).replace(/^\uFEFF/, "")) as { EngineAssociation?: string };
  return { file, dir: dirname(file), engine: String(j.EngineAssociation ?? "") };
}

/** @returns Where the plugin's source is: bundled with the app, or in the repository. */
export function bridgeSource(): string | undefined {
  const resources = (process as { resourcesPath?: string }).resourcesPath;
  const here = dirname(fileURLToPath(import.meta.url));
  return [resources && join(resources, "unreal-plugin", "KesherAIBridge"), resolve(here, "../../../integrations/unreal/KesherAIBridge")].find(
    (p): p is string => !!p && existsSync(join(p, "KesherAIBridge.uplugin")),
  );
}

/** Builds and installs the plugin; one at a time. */
export class BridgeInstaller {
  private job?: InstallJob;

  /** @param dir - Where built plugins are kept, one folder per engine version. */
  constructor(private readonly dir: string) {}

  /** @returns The current or last install. */
  status(): InstallJob | undefined {
    return this.job && { ...this.job, log: this.job.log.slice(-40) };
  }

  /**
   * Installs the plugin into a project: builds it for the project's engine
   * the first time, then copies it in (Binaries only, no source).
   *
   * @param folder - The project folder.
   * @returns When the job has started (it runs on; follow {@link status}).
   * @throws Error when another install runs, the project or its engine is not found, or the plugin source is missing.
   */
  async install(folder: string): Promise<void> {
    if (this.job && (this.job.state === "building" || this.job.state === "copying")) throw new Error("An install is already running.");
    if (process.platform !== "win32") throw new Error("Installing from KesherAI works on Windows for now. On other systems, unzip the plugin into the project's Plugins folder (docs/UNREAL.md).");
    const project = await readProject(folder);
    const engines = await findEngines();
    const engine = engines.find((e) => e.version === project.engine) ?? (project.engine ? undefined : engines[0]);
    if (!engine) throw new Error(`Unreal ${project.engine || "(any)"} was not found on this computer. Installed: ${engines.map((e) => e.version).join(", ") || "none"}.`);
    const source = bridgeSource();
    if (!source) throw new Error("The plugin's files are missing from this copy of KesherAI.");
    const job: InstallJob = { state: "building", project: project.dir, engine: engine.version, log: [] };
    this.job = job;
    void this.run(job, engine, source, project.dir).catch((err: Error) => {
      job.state = "failed";
      job.message = err.message;
    });
  }

  private async run(job: InstallJob, engine: UnrealEngine, source: string, projectDir: string): Promise<void> {
    const version = JSON.parse(await readFile(join(source, "KesherAIBridge.uplugin"), "utf8")) as { VersionName?: string };
    const built = join(this.dir, `${engine.version.replace(/[^\w.-]/g, "_")}-${version.VersionName ?? "0"}`, "KesherAIBridge");
    if (!existsSync(join(built, "Binaries"))) {
      await rm(built, { recursive: true, force: true });
      await mkdir(dirname(built), { recursive: true });
      const uat = join(engine.path, "Engine", "Build", "BatchFiles", "RunUAT.bat");
      const code = await new Promise<number>((res) => {
        const child = spawn("cmd.exe", ["/d", "/s", "/c", `"${uat}" BuildPlugin -Plugin="${join(source, "KesherAIBridge.uplugin")}" -Package="${built}" -TargetPlatforms=Win64`], { windowsHide: true, windowsVerbatimArguments: true });
        const add = (d: Buffer) => {
          for (const line of d.toString().split(/\r?\n/)) if (line.trim()) job.log.push(line.slice(0, 300));
          if (job.log.length > 400) job.log.splice(0, job.log.length - 400);
        };
        child.stdout.on("data", add);
        child.stderr.on("data", add);
        child.on("error", () => res(-1));
        child.on("exit", (c) => res(c ?? -1));
      });
      if (code !== 0 || !existsSync(join(built, "Binaries"))) {
        const text = job.log.join("\n");
        throw new Error(
          /visual studio|msvc|toolchain|compiler/i.test(text)
            ? "Building needs Visual Studio's C++ tools (free): install Visual Studio 2022 Community with “Game development with C++”, then try again."
            : `Unreal's build tool stopped (code ${code}). The last lines are in the log below.`,
        );
      }
    }
    job.state = "copying";
    const dest = join(projectDir, "Plugins", "KesherAIBridge");
    await rm(dest, { recursive: true, force: true });
    await mkdir(dest, { recursive: true });
    // Without Source/ and Intermediate/: Unreal loads the built files and never asks to compile.
    for (const part of ["KesherAIBridge.uplugin", "Binaries", "Resources", "README.md"]) {
      if (existsSync(join(built, part))) await cp(join(built, part), join(dest, part), { recursive: true });
    }
    job.state = "done";
    job.message = `Installed in ${dest}. Open (or restart) the project in Unreal ${engine.version}.`;
  }
}

import { spawn, execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

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
    const j = JSON.parse(text) as {
      InstallationList?: Array<{ InstallLocation?: string; AppName?: string }>;
    };
    return (j.InstallationList ?? [])
      .map((e) => ({
        m: /^UE_(\d+\.\d+)$/.exec(e.AppName ?? ""),
        path: e.InstallLocation ?? "",
      }))
      .filter(
        (e): e is { m: RegExpExecArray; path: string } => !!e.m && !!e.path,
      )
      .map((e) => ({
        version: e.m[1]!,
        path: e.path,
        kind: "launcher" as const,
      }))
      .sort((a, b) =>
        b.version.localeCompare(a.version, undefined, { numeric: true }),
      );
  } catch {
    return [];
  }
}

/** Engines built from source, registered under HKCU\Software\Epic Games\Unreal Engine\Builds. */
async function sourceEngines(): Promise<UnrealEngine[]> {
  const out = await new Promise<string>((res) =>
    execFile(
      "reg",
      ["query", "HKCU\\Software\\Epic Games\\Unreal Engine\\Builds"],
      { windowsHide: true },
      (_e, o) => res(o ?? ""),
    ),
  );
  return out
    .split(/\r?\n/)
    .map((l) => /^\s+(\S+)\s+REG_SZ\s+(.+)$/.exec(l))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => ({
      version: m[1]!,
      path: m[2]!.trim(),
      kind: "source" as const,
    }));
}

/**
 * Engines from the Epic Games Launcher's per-app manifests
 * (`%ProgramData%\Epic\EpicGamesLauncher\Data\Manifests\*.item`). The
 * launcher keeps these even when LauncherInstalled.dat is empty (seen on a
 * PC where UE 5.6 was installed and the list file held no entries).
 *
 * @param texts - The .item files' text.
 */
export function manifestEngines(texts: string[]): UnrealEngine[] {
  const out: UnrealEngine[] = [];
  for (const text of texts) {
    try {
      const j = JSON.parse(text) as {
        AppName?: string;
        InstallLocation?: string;
      };
      const m = /^UE_(\d+\.\d+)$/.exec(j.AppName ?? "");
      if (m && j.InstallLocation)
        out.push({ version: m[1]!, path: j.InstallLocation, kind: "launcher" });
    } catch {
      // not a manifest
    }
  }
  return out;
}

/** Launcher engines registered under HKLM\SOFTWARE\EpicGames\Unreal Engine\<version> (InstalledDirectory). */
async function registeredEngines(): Promise<UnrealEngine[]> {
  const out = await new Promise<string>((res) =>
    execFile(
      "reg",
      [
        "query",
        "HKLM\\SOFTWARE\\EpicGames\\Unreal Engine",
        "/s",
        "/v",
        "InstalledDirectory",
      ],
      { windowsHide: true },
      (_e, o) => res(o ?? ""),
    ),
  );
  const found: UnrealEngine[] = [];
  let version = "";
  for (const line of out.split(/\r?\n/)) {
    const key = /\\Unreal Engine\\(\d+\.\d+)\s*$/i.exec(line);
    if (key) version = key[1]!;
    const dir = /^\s+InstalledDirectory\s+REG_SZ\s+(.+)$/.exec(line);
    if (dir && version)
      found.push({ version, path: dir[1]!.trim(), kind: "launcher" });
  }
  return found;
}

/**
 * Install folders the Epic Games Launcher wrote in its own log
 * (`DestinationPath='E:\\EpicGames\\UE_5.8'`). The 2026 launcher keeps no
 * install list KesherAI can read, but logs every install and verify.
 *
 * @param text - The launcher logs' text.
 */
export function loggedEngines(text: string): UnrealEngine[] {
  const out = new Map<string, UnrealEngine>();
  for (const m of text.matchAll(
    /DestinationPath[=:]\s*'?([A-Za-z]:\\[^'\r\n]*?UE_(\d+\.\d+)[^'\r\n]*?)'?\s*$/gm,
  )) {
    const path = m[1]!.trim();
    out.set(path.toLowerCase(), { version: m[2]!, path, kind: "launcher" });
  }
  return [...out.values()];
}

/** Folders the user pointed to (an engine folder like D:\\UE_5.8, or a folder that holds UE_x.y folders). */
const extraEngineFolders = new Set<string>();
/** Adds folders to look in for engines (Settings or unreal_status's engine_folder). */
export function addEngineFolders(folders: Iterable<string>): void {
  for (const f of folders) if (f && f.trim()) extraEngineFolders.add(f.trim());
  enginesCache = undefined;
}

let enginesCache: { at: number; list: Promise<UnrealEngine[]> } | undefined;

/**
 * @returns Every engine found on this computer (newest first, each folder once). Looked up at most once a
 *   minute: it reads the launcher's logs and lists several drives, and the Unreal tools ask on every call.
 */
export function findEngines(): Promise<UnrealEngine[]> {
  if (!enginesCache || Date.now() - enginesCache.at > 60_000) {
    enginesCache = { at: Date.now(), list: lookForEngines() };
    enginesCache.list.catch(() => (enginesCache = undefined));
  }
  return enginesCache.list;
}

/** Forgets the engines found (after the user names a folder). */
export function forgetEngines(): void {
  enginesCache = undefined;
}

async function lookForEngines(): Promise<UnrealEngine[]> {
  if (process.platform !== "win32") return [];
  const data = process.env.ProgramData ?? "C:\\ProgramData";
  const list = join(
    data,
    "Epic",
    "UnrealEngineLauncher",
    "LauncherInstalled.dat",
  );
  const launcher = launcherEngines(
    await readFile(list, "utf8").catch(() => ""),
  );
  const manDir = join(data, "Epic", "EpicGamesLauncher", "Data", "Manifests");
  const items = (await readdir(manDir).catch(() => [] as string[])).filter(
    (f) => f.endsWith(".item"),
  );
  const manifests = manifestEngines(
    await Promise.all(
      items.map((f) => readFile(join(manDir, f), "utf8").catch(() => "")),
    ),
  );
  const logDir = join(
    process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"),
    "EpicGamesLauncher",
    "Saved",
    "Logs",
  );
  const logs = (await readdir(logDir).catch(() => [] as string[])).filter((f) =>
    /^EpicGamesLauncher.*\.log$/i.test(f),
  );
  const logged = loggedEngines(
    (
      await Promise.all(
        logs.map((f) => readFile(join(logDir, f), "utf8").catch(() => "")),
      )
    ).join("\n"),
  );
  // Common folders on every drive (the new launcher keeps no list KesherAI can read), and the user's own folders.
  const parents = new Set<string>([
    join(process.env.ProgramFiles ?? "C:\\Program Files", "Epic Games"),
    ...extraEngineFolders,
  ]);
  for (const d of "CDEFGH")
    for (const sub of [
      "Epic Games",
      "EpicGames",
      "Program Files\\Epic Games",
      "UnrealEngine",
      "Unreal Engine",
      "Epic",
    ])
      parents.add(`${d}:\\${sub}`);
  for (const sub of [
    "UnrealEngine",
    "Unreal Engine",
    "Epic Games",
    join("source", "repos"),
  ])
    parents.add(join(homedir(), sub));
  const folders: UnrealEngine[] = [];
  for (const parent of parents) {
    // A folder that is itself an engine (e.g. D:\UE_5.8 given by the user).
    const own = /UE_(\d+\.\d+)$/i.exec(parent);
    if (own) folders.push({ version: own[1]!, path: parent, kind: "launcher" });
    for (const f of await readdir(parent).catch(() => [] as string[])) {
      const m = /^UE_(\d+\.\d+)$/i.exec(f);
      if (!m) continue;
      // The launcher sometimes nests it: E:\EpicGames\UE_5.6\UE_5.6.
      const nested = join(parent, f, f);
      folders.push({
        version: m[1]!,
        path: existsSync(join(nested, "Engine")) ? nested : join(parent, f),
        kind: "launcher",
      });
    }
  }
  const seen = new Set<string>();
  return [
    ...launcher,
    ...manifests,
    ...logged,
    ...(await registeredEngines().catch(() => [])),
    ...folders,
    ...(await sourceEngines().catch(() => [])),
  ]
    .filter((e) =>
      existsSync(join(e.path, "Engine", "Build", "BatchFiles", "RunUAT.bat")),
    )
    .filter((e) => {
      const k = resolve(e.path).toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .sort((a, b) =>
      b.version.localeCompare(a.version, undefined, { numeric: true }),
    );
}

/**
 * Finds the project file in a folder and the engine it wants.
 *
 * @param folder - The project folder (or the .uproject file).
 * @returns Its .uproject path and `EngineAssociation` ("5.4", or a source build id).
 * @throws Error when the folder has no .uproject.
 */
export async function readProject(
  folder: string,
): Promise<{ file: string; dir: string; engine: string }> {
  const file = folder.toLowerCase().endsWith(".uproject")
    ? folder
    : (await readdir(folder).catch(() => [] as string[]))
        .filter((f) => f.toLowerCase().endsWith(".uproject"))
        .map((f) => join(folder, f))[0];
  if (!file || !existsSync(file))
    throw new Error("No Unreal project (.uproject) in that folder.");
  const j = JSON.parse(
    (await readFile(file, "utf8")).replace(/^\uFEFF/, ""),
  ) as { EngineAssociation?: string };
  return {
    file,
    dir: dirname(file),
    engine: String(j.EngineAssociation ?? ""),
  };
}

/** @returns Where the plugin's source is: bundled with the app, or in the repository. */
export function bridgeSource(): string | undefined {
  const resources = (process as { resourcesPath?: string }).resourcesPath;
  const here = dirname(fileURLToPath(import.meta.url));
  return [
    resources && join(resources, "unreal-plugin", "KesherAIBridge"),
    resolve(here, "../../../integrations/unreal/KesherAIBridge"),
  ].find(
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
    if (
      this.job &&
      (this.job.state === "building" || this.job.state === "copying")
    )
      throw new Error("An install is already running.");
    if (process.platform !== "win32")
      throw new Error(
        "Installing from KesherAI works on Windows for now. On other systems, unzip the plugin into the project's Plugins folder (docs/UNREAL.md).",
      );
    const project = await readProject(folder);
    const engines = await findEngines();
    const engine =
      engines.find((e) => e.version === project.engine) ??
      (project.engine ? undefined : engines[0]);
    if (!engine)
      throw new Error(
        `Unreal ${project.engine || "(any)"} was not found on this computer. Installed: ${engines.map((e) => e.version).join(", ") || "none"}.`,
      );
    const source = bridgeSource();
    if (!source)
      throw new Error(
        "The plugin's files are missing from this copy of KesherAI.",
      );
    const job: InstallJob = {
      state: "building",
      project: project.dir,
      engine: engine.version,
      log: [],
    };
    this.job = job;
    void this.run(job, engine, source, project.dir).catch((err: Error) => {
      job.state = "failed";
      job.message = err.message;
    });
  }

  private async run(
    job: InstallJob,
    engine: UnrealEngine,
    source: string,
    projectDir: string,
  ): Promise<void> {
    const version = JSON.parse(
      await readFile(join(source, "KesherAIBridge.uplugin"), "utf8"),
    ) as { VersionName?: string };
    const built = join(
      this.dir,
      `${engine.version.replace(/[^\w.-]/g, "_")}-${version.VersionName ?? "0"}`,
      "KesherAIBridge",
    );
    if (!existsSync(join(built, "Binaries"))) {
      await rm(built, { recursive: true, force: true });
      await mkdir(dirname(built), { recursive: true });
      const uat = join(
        engine.path,
        "Engine",
        "Build",
        "BatchFiles",
        "RunUAT.bat",
      );
      const code = await new Promise<number>((res) => {
        const child = spawn(
          "cmd.exe",
          [
            "/d",
            "/s",
            "/c",
            `"${uat}" BuildPlugin -Plugin="${join(source, "KesherAIBridge.uplugin")}" -Package="${built}" -TargetPlatforms=Win64`,
          ],
          { windowsHide: true, windowsVerbatimArguments: true },
        );
        const add = (d: Buffer) => {
          for (const line of d.toString().split(/\r?\n/))
            if (line.trim()) job.log.push(line.slice(0, 300));
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
    for (const part of [
      "KesherAIBridge.uplugin",
      "Binaries",
      "Resources",
      "README.md",
    ]) {
      if (existsSync(join(built, part)))
        await cp(join(built, part), join(dest, part), { recursive: true });
    }
    job.state = "done";
    job.message = `Installed in ${dest}. Open (or restart) the project in Unreal ${engine.version}.`;
  }
}

/** @returns Where the Unity package's files are: bundled with the app, or in the repository. */
export function unityPackageSource(): string | undefined {
  const resources = (process as { resourcesPath?: string }).resourcesPath;
  const here = dirname(fileURLToPath(import.meta.url));
  return [
    resources && join(resources, "unity-package", "com.kesherai.bridge"),
    resolve(here, "../../../integrations/unity/com.kesherai.bridge"),
  ].find((p): p is string => !!p && existsSync(join(p, "package.json")));
}

/**
 * Adds the KesherAI Bridge package to a Unity project, as an embedded
 * package (`Packages/com.kesherai.bridge`): Unity compiles it by itself, and
 * neither git nor a compiler is needed. An older copy is replaced.
 *
 * @param folder - The Unity project folder (the one with Assets/ and Packages/).
 * @returns What to tell the user.
 * @throws Error when the folder is not a Unity project or the package files are missing.
 */
export async function installUnityPackage(folder: string): Promise<string> {
  if (
    !existsSync(join(folder, "Assets")) ||
    !existsSync(join(folder, "Packages", "manifest.json"))
  )
    throw new Error(
      "That is not a Unity project folder (it needs Assets/ and Packages/manifest.json).",
    );
  const source = unityPackageSource();
  if (!source)
    throw new Error(
      "The package's files are missing from this copy of KesherAI.",
    );
  const dest = join(folder, "Packages", "com.kesherai.bridge");
  await rm(dest, { recursive: true, force: true });
  await cp(source, dest, { recursive: true });
  return `Added to ${dest}. Unity loads it the next time it gets focus (Visual Scripting is added too if the project lacks it).`;
}

/** Plugins that are editor tools only: a game (a phone build above all) must not pack or start them. */
export const EDITOR_ONLY_PLUGINS = [
  "ModelContextProtocol",
  "AllToolsets",
  "PythonScriptPlugin",
  "EditorScriptingUtilities",
];

/** Marks the editor-only plugins of a .uproject's list with TargetAllowList ["Editor"]; true when something changed. */
export function markEditorOnly(
  plugins: Array<{
    Name?: string;
    Enabled?: boolean;
    TargetAllowList?: string[];
  }>,
): boolean {
  let changed = false;
  for (const p of plugins) {
    if (
      p?.Name &&
      EDITOR_ONLY_PLUGINS.includes(p.Name) &&
      p.Enabled &&
      !(
        Array.isArray(p.TargetAllowList) &&
        p.TargetAllowList.length === 1 &&
        p.TargetAllowList[0] === "Editor"
      )
    ) {
      p.TargetAllowList = ["Editor"];
      changed = true;
    }
  }
  return changed;
}

/**
 * Keeps the editor-only plugins out of the game in a project's .uproject
 * (a copy of the old file is kept next to it).
 *
 * @returns What changed, or "" when nothing had to.
 */
export async function keepEditorPluginsOutOfGame(
  folder: string,
): Promise<string> {
  const { file } = await readProject(folder);
  const text = (await readFile(file, "utf8")).replace(/^\uFEFF/, "");
  const j = JSON.parse(text) as {
    Plugins?: Array<{
      Name?: string;
      Enabled?: boolean;
      TargetAllowList?: string[];
    }>;
  };
  if (!Array.isArray(j.Plugins) || !markEditorOnly(j.Plugins)) return "";
  if (!existsSync(`${file}.kesher-backup`))
    await writeFile(`${file}.kesher-backup`, text); // the first original is kept
  await writeFile(file, `${JSON.stringify(j, null, "\t")}\n`);
  return `Editor-only plugins (${j.Plugins.filter(
    (p) => p.TargetAllowList?.[0] === "Editor",
  )
    .map((p) => p.Name)
    .join(
      ", ",
    )}) are now kept out of the game build (TargetAllowList Editor in ${file}; the old file is ${file}.kesher-backup).`;
}

/** An engine's exact version from Engine/Build/Build.version, e.g. [5, 8, 2]. */
export async function engineVersion(
  enginePath: string,
): Promise<[number, number, number] | undefined> {
  try {
    const j = JSON.parse(
      await readFile(
        join(enginePath, "Engine", "Build", "Build.version"),
        "utf8",
      ),
    ) as {
      MajorVersion?: number;
      MinorVersion?: number;
      PatchVersion?: number;
    };
    return [
      Number(j.MajorVersion),
      Number(j.MinorVersion),
      Number(j.PatchVersion ?? 0),
    ];
  } catch {
    return undefined;
  }
}

/** Sets a key in one section of an .ini text (adds the section or key when missing). */
export function setIniKey(
  text: string,
  section: string,
  key: string,
  value: string,
): string {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === section);
  if (start < 0)
    return `${text.replace(/\s*$/, "")}\n\n${section}\n${key}=${value}\n`;
  let end = lines.findIndex(
    (l, i) => i > start && /^\[.*\]\s*$/.test(l.trim()),
  );
  if (end < 0) end = lines.length;
  const at = lines.findIndex(
    (l, i) => i > start && i < end && l.split("=")[0]?.trim() === key,
  );
  if (at >= 0) lines[at] = `${key}=${value}`;
  else lines.splice(start + 1, 0, `${key}=${value}`);
  return lines.join("\n");
}

/**
 * Turns on Unreal Engine's own MCP server in a project (Unreal 5.8 and
 * newer): the ModelContextProtocol and AllToolsets plugins in the
 * .uproject (a copy of the old file is kept next to it), and "start the
 * server with the editor" in the project's per-user editor settings. The
 * next time the project opens, KesherAI's chats reach the editor's tools.
 *
 * @param folder - The project folder (or its .uproject).
 * @returns What changed, in words.
 */
export async function enableUnrealMcp(folder: string): Promise<string> {
  const { file, dir, engine } = await readProject(folder);
  const text = (await readFile(file, "utf8")).replace(/^\uFEFF/, "");
  const j = JSON.parse(text) as {
    Plugins?: Array<{
      Name?: string;
      Enabled?: boolean;
      TargetAllowList?: string[];
    }>;
  };
  const plugins = Array.isArray(j.Plugins) ? j.Plugins : [];
  let changed = false;
  for (const name of ["ModelContextProtocol", "AllToolsets"]) {
    const p = plugins.find((x) => x?.Name === name);
    if (!p) {
      plugins.push({ Name: name, Enabled: true, TargetAllowList: ["Editor"] });
      changed = true;
    } else if (p.Enabled !== true) {
      p.Enabled = true;
      changed = true;
    }
  }
  if (markEditorOnly(plugins)) changed = true;
  if (changed) {
    if (!existsSync(`${file}.kesher-backup`))
      await writeFile(`${file}.kesher-backup`, text); // the first original is kept
    j.Plugins = plugins;
    await writeFile(file, `${JSON.stringify(j, null, "\t")}\n`);
  }
  // Per-user editor settings (not in source control): start the MCP server with the editor.
  const platform =
    process.platform === "win32"
      ? "WindowsEditor"
      : process.platform === "darwin"
        ? "MacEditor"
        : "LinuxEditor";
  const iniDir = join(dir, "Saved", "Config", platform);
  const ini = join(iniDir, "EditorPerProjectUserSettings.ini");
  const section =
    "[/Script/ModelContextProtocolEngine.ModelContextProtocolSettings]";
  let cur = existsSync(ini) ? await readFile(ini, "utf8") : "";
  if (!/bAutoStartServer\s*=\s*True/i.test(cur)) {
    if (cur.includes(section))
      cur = cur
        .replace(section, `${section}\nbAutoStartServer=True`)
        .replace(/\nbAutoStartServer\s*=\s*False/gi, "");
    else
      cur = `${cur.trimEnd()}${cur ? "\n\n" : ""}${section}\nbAutoStartServer=True\n`;
    await mkdir(iniDir, { recursive: true });
    await writeFile(ini, cur);
  }
  const old = /^5\.[0-7](\.|$)/.test(engine) || /^4\./.test(engine);
  return `${changed ? "Turned on the Unreal MCP and All Toolsets plugins" : "The plugins were already on"}, and the server now starts with the editor. ${old ? `This project is on Unreal ${engine}: Unreal's MCP server needs 5.8 or newer, so use the KesherAI Bridge plugin instead (Install into a project).` : "Open (or restart) the project in Unreal; KesherAI connects to it by itself."}`;
}

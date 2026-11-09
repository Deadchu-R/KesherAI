import { spawn, execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { AgentTool } from "@kesher/agent";
import { addEngineFolders, findEngines, readProject, enableUnrealMcp, type UnrealEngine } from "./unreal-install.js";
import { projectPath } from "./unity-tools.js";
import type { JobStore } from "./jobs.js";

/**
 * Unreal in the chat, the way the Unity tools work: the model sees the
 * project, writes C++ into Source/, compiles it with Unreal's own build tool
 * and reads the errors, runs editor Python headless, opens the editor (whose
 * own MCP server, in 5.8, then gives the scene tools), and packages a game
 * for Windows or Android with RunUAT BuildCookRun.
 *
 * Why C++ and not Blueprints for game logic: people who used Unreal 5.8's
 * MCP toolsets agentically report that Blueprint graph editing through it is
 * fragile (call-function nodes "do not exist", changes need compile + save,
 * errors come back as success text). C++ with real compiler errors is the
 * loop that worked for Unity (write → compile → fix).
 *
 * Safety: every program gets its arguments as a list (no shell); paths stay
 * inside the project (Source/, Config/, Content/Python/); the build, Python
 * and packaging ask the user first like any command.
 */

const MAX_OUT = 8000;
const cut = (s: string) => (s.length > MAX_OUT ? `…(${s.length - MAX_OUT} characters before)\n${s.slice(-MAX_OUT)}` : s);
const CODE_EXT = /\.(h|hpp|cpp|cs|ini|py)$/i;
const ROOTS = ["Source", "Config", "Content/Python"];
const NAME = /^[A-Za-z][A-Za-z0-9]{1,30}$/;

/** The tools tool search must never hide while an Unreal project is in use. */
export const UNREAL_TOOL_NAMES = [
  "unreal_status",
  "unreal_create_project",
  "unreal_use_project",
  "unreal_list_source",
  "unreal_read_source",
  "unreal_write_source",
  "unreal_compile",
  "unreal_python",
  "unreal_open_editor",
  "unreal_package",
] as const;

export const UNREAL_NOTE =
  "Unreal tools work on the user's Unreal project on this computer. NEVER say you made, compiled or packaged something unless a tool result in this chat shows it. The loop: 1) unreal_status (engines, project, compiler, Android tools, whether the editor's MCP server answers). 2) A new game: unreal_create_project makes a small C++ project set up for phones (mobile renderer, scalable, no starter content) with a game module, a GameMode and the editor's MCP turned on. 3) unreal_list_source / unreal_read_source, then unreal_write_source for .h/.cpp under Source/<Name>/ and unreal_compile; read the errors and fix until it compiles. Game logic in C++: spawn what the game needs in code (engine shapes /Engine/BasicShapes/Cube.Cube, material /Engine/BasicShapes/BasicShapeMaterial.BasicShapeMaterial with a UMaterialInstanceDynamic and its \"Color\" parameter), so no assets must be made by hand; text with AHUD::DrawText; touch through APlayerController (bEnableClickEvents/bEnableTouchEvents, GetHitResultUnderFinger or DeprojectScreenPositionToWorld + LineTraceSingleByChannel). Keep everything light for phones: few objects, no dynamic shadows, no post effects. 4) unreal_python runs Unreal editor Python headless (editor closed) for assets and levels: unreal.EditorAssetLibrary, unreal.LevelEditorSubsystem, unreal.EditorLevelLibrary. 5) unreal_open_editor lets the user see it; with Unreal 5.8 its MCP tools then appear (list_toolsets → describe_toolset → call_tool, never guessed). 6) unreal_package builds the game (android or windows) when the user asks for a build; it takes long (the first Android build can take 30+ minutes). Builds keep running if KesherAI restarts: when the user says continue after a restart, call the same tool again and it joins the running build. Never install system software yourself (winget, Visual Studio Installer, SDKs, drivers): when unreal_status or a compile says something is missing, tell the user exactly what to install and stop. At the end, list exactly what changed.";

type Run = { code: number; out: string };
/** Runs a program with arguments (no shell) and collects its output; the log file gets everything. */
function runProgram(file: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs: number; log?: string }): Promise<Run> {
  return new Promise((res) => {
    let out = "";
    // Node on Windows will not start a .bat/.cmd directly (spawn EINVAL since the 2024 fix): run it through cmd.exe,
    // each argument quoted. Arguments with quotes or cmd's special characters are refused rather than escaped.
    const bat = process.platform === "win32" && /\.(bat|cmd)$/i.test(file);
    if (bat && [file, ...args].some((a) => /["%^&|<>\r\n]/.test(a))) {
      res({ code: -1, out: "A path or argument has a character Windows' command line cannot pass safely (\" % ^ & | < >)." });
      return;
    }
    const child = bat
      ? spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `"${[file, ...args].map((a) => `"${a}"`).join(" ")}"`], { cwd: opts.cwd, env: opts.env ?? process.env, windowsHide: true, windowsVerbatimArguments: true })
      : spawn(file, args, { cwd: opts.cwd, env: opts.env ?? process.env, windowsHide: true });
    const add = (b: Buffer) => {
      const s = b.toString("utf8");
      out = (out + s).slice(-400_000);
      if (opts.log) void appendFile(opts.log, s).catch(() => undefined);
    };
    child.stdout.on("data", add);
    child.stderr.on("data", add);
    const timer = setTimeout(() => child.kill(), opts.timeoutMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      res({ code: -1, out: `${out}\n${e.message}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      res({ code: code ?? -1, out });
    });
  });
}

/** Visual Studio with the C++ tools (vswhere), or undefined. */
async function visualStudio(): Promise<string | undefined> {
  if (process.platform !== "win32") return undefined;
  const vswhere = join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Microsoft Visual Studio", "Installer", "vswhere.exe");
  if (!existsSync(vswhere)) return undefined;
  const out = await new Promise<string>((res) =>
    execFile(vswhere, ["-latest", "-products", "*", "-requires", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64", "-property", "displayName"], { windowsHide: true, timeout: 10_000 }, (_e, o) => res(String(o ?? "").trim())),
  );
  return out || undefined;
}

/** The newest Windows 10/11 SDK Unreal can build with (Windows Kits\\10\\Include\\10.0.x), or undefined. */
async function windowsSdk(): Promise<string | undefined> {
  if (process.platform !== "win32") return undefined;
  for (const pf of [process.env["ProgramFiles(x86)"], process.env.ProgramFiles]) {
    if (!pf) continue;
    const inc = join(pf, "Windows Kits", "10", "Include");
    const versions = (await readdir(inc).catch(() => [] as string[])).filter((v) => /^10\.0\.\d+\.\d+$/.test(v) && existsSync(join(inc, v, "um", "windows.h")));
    versions.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    if (versions.length) return versions.at(-1);
  }
  return undefined;
}

/** Android SDK, NDK and JDK: the user's own, else the ones Unity installed with its Android module. */
export async function androidTools(): Promise<{ sdk?: string; ndk?: string; jdk?: string; from: string }> {
  const env = process.env;
  let sdk = [env.ANDROID_HOME, env.ANDROID_SDK_ROOT, env.LOCALAPPDATA && join(env.LOCALAPPDATA, "Android", "Sdk")].find((p): p is string => !!p && existsSync(join(p, "platform-tools")));
  let ndk = [env.NDKROOT, env.NDK_ROOT, env.ANDROID_NDK_HOME].find((p): p is string => !!p && existsSync(p));
  if (!ndk && sdk) {
    const dirs = (await readdir(join(sdk, "ndk")).catch(() => [] as string[])).sort().reverse();
    if (dirs[0]) ndk = join(sdk, "ndk", dirs[0]);
  }
  let jdk = [env.JAVA_HOME, env.ProgramFiles && join(env.ProgramFiles, "Android", "Android Studio", "jbr")].find((p): p is string => !!p && existsSync(join(p, "bin")));
  let from = "your Android tools";
  // Unity's Android module (Hub default folder): SDK, NDK r27c and OpenJDK, the versions UE 5.8 asks for.
  const hub = join(env.ProgramFiles ?? "C:\\Program Files", "Unity", "Hub", "Editor");
  for (const v of (await readdir(hub).catch(() => [] as string[])).sort().reverse()) {
    const ap = join(hub, v, "Editor", "Data", "PlaybackEngines", "AndroidPlayer");
    if (!existsSync(ap)) continue;
    if (!sdk && existsSync(join(ap, "SDK"))) {
      sdk = join(ap, "SDK");
      from = `Unity ${v}'s Android module`;
    }
    if (!ndk && existsSync(join(ap, "NDK"))) ndk = join(ap, "NDK");
    if (!jdk && existsSync(join(ap, "OpenJDK"))) jdk = join(ap, "OpenJDK");
  }
  return { sdk, ndk, jdk, from };
}

/** Does the editor's MCP server (Unreal 5.8, port 8000) answer? */
async function mcpUp(): Promise<boolean> {
  try {
    const r = await fetch("http://127.0.0.1:8000/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }), signal: AbortSignal.timeout(2000) });
    return r.status < 500;
  } catch {
    return false;
  }
}

/** The engine a project wants (its EngineAssociation), else the newest installed. */
function engineFor(engines: UnrealEngine[], want: string): UnrealEngine | undefined {
  return engines.find((e) => e.version === want) ?? engines.find((e) => want && e.version.startsWith(want)) ?? (want ? undefined : engines[0]);
}

/**
 * The files of a new, small C++ project made for phones. No binary assets:
 * the game spawns what it needs in code, and the default map is the
 * engine's empty Entry map until the game makes its own.
 *
 * @param name - Project and module name (letters and digits).
 * @param engine - EngineAssociation, e.g. "5.8".
 * @returns Relative path → text.
 */
export function newProjectFiles(name: string, engine: string): Record<string, string> {
  const api = `${name.toUpperCase()}_API`;
  return {
    [`${name}.uproject`]: `${JSON.stringify(
      {
        FileVersion: 3,
        EngineAssociation: engine,
        Category: "",
        Description: "Made with KesherAI",
        Modules: [{ Name: name, Type: "Runtime", LoadingPhase: "Default" }],
        Plugins: [
          { Name: "ModelingToolsEditorMode", Enabled: false },
          { Name: "PythonScriptPlugin", Enabled: true },
          { Name: "EditorScriptingUtilities", Enabled: true },
          ...(/^5\.([89]|\d\d)/.test(engine) || /^[6-9]\./.test(engine) ? [{ Name: "ModelContextProtocol", Enabled: true }, { Name: "AllToolsets", Enabled: true }] : []),
        ],
        TargetPlatforms: ["Android", "Windows"],
      },
      null,
      "\t",
    )}\n`,
    [`Source/${name}.Target.cs`]: `using UnrealBuildTool;\n\npublic class ${name}Target : TargetRules\n{\n\tpublic ${name}Target(TargetInfo Target) : base(Target)\n\t{\n\t\tType = TargetType.Game;\n\t\tDefaultBuildSettings = BuildSettingsVersion.Latest;\n\t\tIncludeOrderVersion = EngineIncludeOrderVersion.Latest;\n\t\tExtraModuleNames.Add("${name}");\n\t}\n}\n`,
    [`Source/${name}Editor.Target.cs`]: `using UnrealBuildTool;\n\npublic class ${name}EditorTarget : TargetRules\n{\n\tpublic ${name}EditorTarget(TargetInfo Target) : base(Target)\n\t{\n\t\tType = TargetType.Editor;\n\t\tDefaultBuildSettings = BuildSettingsVersion.Latest;\n\t\tIncludeOrderVersion = EngineIncludeOrderVersion.Latest;\n\t\tExtraModuleNames.Add("${name}");\n\t}\n}\n`,
    [`Source/${name}/${name}.Build.cs`]: `using UnrealBuildTool;\n\npublic class ${name} : ModuleRules\n{\n\tpublic ${name}(ReadOnlyTargetRules Target) : base(Target)\n\t{\n\t\tPCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;\n\t\tPublicDependencyModuleNames.AddRange(new string[] { "Core", "CoreUObject", "Engine", "InputCore" });\n\t}\n}\n`,
    [`Source/${name}/${name}.cpp`]: `#include "Modules/ModuleManager.h"\n\nIMPLEMENT_PRIMARY_GAME_MODULE(FDefaultGameModuleImpl, ${name}, "${name}");\n`,
    [`Source/${name}/${name}GameMode.h`]: `#pragma once\n\n#include "CoreMinimal.h"\n#include "GameFramework/GameModeBase.h"\n#include "${name}GameMode.generated.h"\n\n/** The game's rules. Spawns everything the game needs in BeginPlay. */\nUCLASS()\nclass ${api} A${name}GameMode : public AGameModeBase\n{\n\tGENERATED_BODY()\npublic:\n\tvirtual void BeginPlay() override;\n};\n`,
    [`Source/${name}/${name}GameMode.cpp`]: `#include "${name}GameMode.h"\n\nvoid A${name}GameMode::BeginPlay()\n{\n\tSuper::BeginPlay();\n}\n`,
    "Config/DefaultGame.ini": `[/Script/EngineSettings.GeneralProjectSettings]\nProjectName=${name}\nProjectID=${[...Array(32)].map(() => "0123456789ABCDEF"[Math.floor(Math.random() * 16)]).join("")}\n\n[/Script/UnrealEd.ProjectPackagingSettings]\nBuildConfiguration=PPBC_Development\nbShareMaterialShaderCode=True\nbSharedMaterialNativeLibraries=True\nbUseIoStore=True\nbCompressed=True\nIncludePrerequisites=False\n\n[/Script/Engine.AssetManagerSettings]\n+PrimaryAssetTypesToScan=(PrimaryAssetType="GameFeatureData",AssetBaseClass=/Script/GameFeatures.GameFeatureData,bHasBlueprintClasses=False,bIsEditorOnly=False,Directories=((Path="/Game/Unused")),SpecificAssets=,Rules=(Priority=-1,ChunkId=-1,bApplyRecursively=True,CookRule=AlwaysCook))\n`,
    "Config/DefaultEngine.ini": [
      "[/Script/EngineSettings.GameMapsSettings]",
      "GameDefaultMap=/Engine/Maps/Entry.Entry",
      "EditorStartupMap=/Engine/Maps/Entry.Entry",
      `GlobalDefaultGameMode=/Script/${name}.${name}GameMode`,
      "",
      "[/Script/HardwareTargeting.HardwareTargetingSettings]",
      "TargetedHardwareClass=Mobile",
      "AppliedTargetedHardwareClass=Mobile",
      "DefaultGraphicsPerformance=Scalable",
      "AppliedDefaultGraphicsPerformance=Scalable",
      "",
      "[/Script/Engine.RendererSettings]",
      "r.Mobile.EnableStaticAndCSMShadowReceivers=False",
      "r.DefaultFeature.AutoExposure=False",
      "r.DefaultFeature.MotionBlur=False",
      "r.DefaultFeature.Bloom=False",
      "r.DynamicGlobalIlluminationMethod=0",
      "r.ReflectionMethod=0",
      "r.Shadow.Virtual.Enable=0",
      "r.GenerateMeshDistanceFields=False",
      "r.MobileHDR=False",
      "",
      "[/Script/AndroidRuntimeSettings.AndroidRuntimeSettings]",
      `PackageName=com.kesherai.${name.toLowerCase()}`,
      `ApplicationDisplayName=${name}`,
      "bPackageDataInsideApk=True",
      "bBuildForArm64=True",
      "bBuildForX8664=False",
      "bSupportsVulkan=True",
      "bBuildForES31=True",
      "MinSDKVersion=29",
      "TargetSDKVersion=35",
      "Orientation=SensorLandscape",
      "bFullScreen=True",
      "",
    ].join("\n"),
    "Config/DefaultInput.ini": "[/Script/Engine.InputSettings]\nbUseMouseForTouch=True\nDefaultTouchInterface=None\n",
  };
}

/**
 * @param state - Holds the chat's current Unreal project (shared with the page).
 * @param logsDir - Where the build and package logs go.
 */
export function unrealTools(state: { project?: string }, logsDir: string, jobs?: JobStore): AgentTool[] {
  /**
   * A long build as a job that survives a KesherAI restart (update, closing the app): a job with the same key
   * that is still running is joined instead of starting a second one, so "continue" after a restart picks up the
   * build where it is. Stop in the chat stops the job; KesherAI quitting does not.
   */
  const longRun = async (key: string, file: string, args: string[], opts: { env?: NodeJS.ProcessEnv; timeoutMs: number; log: string; signal?: AbortSignal }): Promise<Run & { note: string }> => {
    if (!jobs) return { ...(await runProgram(file, args, { env: opts.env, timeoutMs: opts.timeoutMs, log: opts.log })), note: "" };
    const old = await jobs.find(key);
    const rec = old?.state === "running" ? old : await jobs.start(key, file, args, { env: opts.env });
    const note = old?.state === "running" ? `Joined the same build already running since ${new Date(old.startedAt).toLocaleTimeString()} (it kept going while KesherAI restarted). ` : "";
    const onAbort = () => jobs.stop(rec);
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const st = await jobs.wait(rec, { timeoutMs: opts.timeoutMs, signal: opts.signal });
      await writeFile(opts.log, st.output).catch(() => undefined);
      if (st.state === "running") return { code: -2, out: st.output, note: `${note}Still running after ${Math.round(opts.timeoutMs / 60000)} minutes; call this tool again to keep waiting for it. ` };
      if (st.state === "stopped") return { code: -1, out: st.output, note: `${note}The build stopped before it finished (KesherAI or the computer was closed, or it was stopped). Call the tool again to run it again; Unreal continues from what was already built. ` };
      return { code: st.code ?? -1, out: st.output, note };
    } finally {
      opts.signal?.removeEventListener("abort", onAbort);
    }
  };
  const need = async () => {
    if (!state.project) throw new Error("No Unreal project is chosen. Use unreal_create_project for a new one or unreal_use_project with the folder of an existing one.");
    return readProject(state.project);
  };
  const engineOf = async (want: string) => {
    const engines = await findEngines();
    const e = engineFor(engines, want);
    if (!e) throw new Error(engines.length ? `Unreal ${want} is not installed here (installed: ${engines.map((x) => x.version).join(", ")}).` : "No Unreal Engine is installed on this computer (Epic Games Launcher → Unreal Engine → Library).");
    return e;
  };
  const moduleName = (file: string) => basename(file).replace(/\.uproject$/i, "");
  return [
    {
      risk: "read",
      spec: {
        name: "unreal_status",
        description: "What is ready for Unreal work: installed engines (and whether they can build for Android), the chat's project, Visual Studio's C++ tools, the Android SDK/NDK/JDK, and whether the editor's MCP server answers. If the user says where an engine is installed, pass engine_folder.",
        inputSchema: { type: "object", properties: { engine_folder: { type: "string", description: "Where an engine is installed, e.g. D:\\Epic Games\\UE_5.8 (optional)." } } },
      },
      run: async (input) => {
        if (typeof input.engine_folder === "string" && input.engine_folder.trim()) addEngineFolders([input.engine_folder]);
        const engines = await findEngines();
        const vs = await visualStudio();
        const a = await androidTools();
        const lines = [
          engines.length ? `Engines: ${engines.map((e) => `${e.version} (${e.path}${existsSync(join(e.path, "Engine", "Binaries", "Android")) || existsSync(join(e.path, "Engine", "Platforms", "Android")) ? ", Android ok" : ", NO Android support installed — Epic Launcher → engine ▾ → Options → Android"})`).join("; ")}` : "No Unreal Engine installed here.",
          `Project: ${state.project ?? "none chosen"}`,
          `C++ compiler: ${vs ?? "Visual Studio with 'Desktop development with C++' NOT found (needed to compile C++ projects)"}`,
          `Windows SDK: ${(await windowsSdk()) ?? "NOT found — Unreal cannot build for Windows without it. The user installs it: Visual Studio Installer → Modify → 'Game development with C++' and a Windows 11 SDK. Do not install it yourself."}`,
          `Android: SDK ${a.sdk ?? "missing"}, NDK ${a.ndk ?? "missing"}, JDK ${a.jdk ?? "missing"} (from ${a.from})`,
          `Editor MCP server (Unreal 5.8): ${(await mcpUp()) ? "answers on 127.0.0.1:8000" : "not running (open the project in the editor)"}`,
        ];
        return { output: lines.join("\n") };
      },
    },
    {
      risk: "write",
      spec: {
        name: "unreal_create_project",
        description: "Make a new small C++ Unreal project set up for phones (mobile renderer, scalable, no starter content, Android settings, MCP on for 5.8+) with a game module and a GameMode. Then write the game in C++ and unreal_compile.",
        inputSchema: { type: "object", properties: { name: { type: "string", description: "Letters and digits, e.g. AutoShooter." }, folder: { type: "string", description: "Parent folder (default: ~/Unreal Projects)." }, engine: { type: "string", description: "Engine version, e.g. 5.8 (default: the newest installed)." } }, required: ["name"] },
      },
      preview: async (input) => `New Unreal project ${String(input.name)} in ${String(input.folder ?? join(homedir(), "Unreal Projects"))}`,
      run: async (input) => {
        const name = String(input.name ?? "");
        if (!NAME.test(name)) throw new Error("The name must start with a letter and have only letters and digits (2–31), e.g. AutoShooter.");
        const e = await engineOf(String(input.engine ?? ""));
        const parent = String(input.folder ?? "").trim() || join(homedir(), "Unreal Projects");
        const dir = join(parent, name);
        if (existsSync(join(dir, `${name}.uproject`))) throw new Error(`${dir} already has a project; use unreal_use_project.`);
        for (const [rel, text] of Object.entries(newProjectFiles(name, e.version))) {
          await mkdir(dirname(join(dir, rel)), { recursive: true });
          await writeFile(join(dir, rel), text);
        }
        await mkdir(join(dir, "Content"), { recursive: true });
        const mcp = /^5\.[0-7]/.test(e.version) ? "" : ` ${await enableUnrealMcp(dir).catch(() => "")}`;
        state.project = dir;
        return { output: `Made ${dir} for Unreal ${e.version}: Source/${name}/ (module, ${name}GameMode), Config/ set for phones, the game starts with ${name}GameMode on the engine's empty map.${mcp}\nNext: write the game's C++ with unreal_write_source, then unreal_compile.` };
      },
    },
    {
      risk: "read",
      spec: { name: "unreal_use_project", description: "Work on an existing Unreal project (its folder or .uproject).", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
      run: async (input) => {
        const p = await readProject(String(input.path ?? ""));
        state.project = p.dir;
        return { output: `Now working on ${p.file} (Unreal ${p.engine || "?"}).` };
      },
    },
    {
      risk: "read",
      spec: { name: "unreal_list_source", description: "List the project's code and settings files (Source/, Config/, Content/Python/).", inputSchema: { type: "object", properties: {} } },
      run: async () => {
        const p = await need();
        const found: string[] = [];
        const walk = async (rel: string, depth: number) => {
          for (const d of await readdir(join(p.dir, rel), { withFileTypes: true }).catch(() => [])) {
            const r = `${rel}/${d.name}`;
            if (d.isDirectory() && depth < 6) await walk(r, depth + 1);
            else if (d.isFile() && CODE_EXT.test(d.name)) found.push(`${r} (${(await stat(join(p.dir, r))).size} B)`);
          }
        };
        for (const r of ROOTS) await walk(r, 0);
        return { output: found.length ? found.join("\n") : "No code files yet." };
      },
    },
    {
      risk: "read",
      spec: { name: "unreal_read_source", description: "Read a code or settings file of the project (e.g. Source/AutoShooter/AutoShooterGameMode.cpp).", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
      run: async (input) => {
        const p = await need();
        const { abs } = projectPath(p.dir, String(input.path ?? ""), ROOTS);
        return { output: cut(await readFile(abs, "utf8")) };
      },
    },
    {
      risk: "write",
      spec: {
        name: "unreal_write_source",
        description: "Write a whole C++ (.h/.cpp), build (.cs), settings (.ini) or editor Python (.py) file into Source/, Config/ or Content/Python/. Folders are made. Then unreal_compile.",
        inputSchema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] },
      },
      preview: async (input) => `Write ${String(input.path)} (${String(input.content ?? "").length} characters)`,
      run: async (input) => {
        const p = await need();
        const { abs, rel } = projectPath(p.dir, String(input.path ?? ""), ROOTS);
        if (!CODE_EXT.test(abs)) throw new Error("Only .h, .cpp, .cs, .ini and .py files can be written here.");
        const content = String(input.content ?? "");
        if (content.length > 300_000) throw new Error("That file is too long.");
        await mkdir(dirname(abs), { recursive: true });
        await writeFile(abs, content);
        return { output: `Wrote ${rel} (${content.length} characters). Compile with unreal_compile.` };
      },
    },
    {
      risk: "exec",
      spec: { name: "unreal_compile", description: "Compile the project's C++ for the editor (Unreal's Build.bat, Win64 Development) and report the errors. Close the editor first, or it may refuse (Live Coding).", inputSchema: { type: "object", properties: {} } },
      preview: async () => `Build.bat <project>Editor Win64 Development (${state.project ?? "no project"})`,
      run: async (_input, ctx) => {
        const p = await need();
        const e = await engineOf(p.engine);
        const name = moduleName(p.file);
        await mkdir(logsDir, { recursive: true });
        const log = join(logsDir, "unreal-build.log");
        await writeFile(log, `> Build.bat ${name}Editor Win64 Development\n`);
        const r = await longRun(`unreal-compile:${p.file}`, join(e.path, "Engine", "Build", "BatchFiles", "Build.bat"), [`${name}Editor`, "Win64", "Development", `-Project=${p.file}`, "-WaitMutex", "-NoHotReload"], { timeoutMs: 3_600_000, log, signal: ctx?.signal });
        if (r.code === 0) return { output: `${r.note}Compiled with no errors.\n${cut(r.out.split("\n").filter((l) => /warning/i.test(l)).join("\n"))}` };
        const errors = r.out.split(/\r?\n/).filter((l) => /\berror\b|fatal/i.test(l));
        const why = /SDK validation failed|Sdk: not found/i.test(r.out)
          ? "The Windows SDK is missing (not a problem in the code). STOP and ask the user to install it: Visual Studio Installer → Modify → 'Game development with C++' and a Windows 11 SDK. Do not install it yourself.\n"
          : /Live ?Coding/i.test(r.out) ? "The editor is open with Live Coding: close the editor (or compile there with Ctrl+Alt+F11), then compile again.\n" : !errors.some((l) => /\.(h|cpp)\(\d+/i.test(l)) && /(Visual Studio|MSVC|compiler|toolchain).{0,60}(not found|not installed|missing|could not be found)/i.test(r.out) ? "Visual Studio's C++ tools were not found. STOP and ask the user to install Visual Studio with 'Game development with C++'. Do not install it yourself.\n" : errors.length ? "These are errors in the code: fix the files.\n" : "";
        return { output: `${r.note}Compile FAILED (exit ${r.code}). ${why}Errors (fix them, write the files again, compile again):\n${cut((errors.length ? errors : r.out.split("\n").slice(-60)).join("\n"))}` };
      },
    },
    {
      risk: "exec",
      spec: {
        name: "unreal_python",
        description: "Run Unreal editor Python headless on the project (UnrealEditor-Cmd -run=pythonscript; the editor must be closed and the C++ compiled). For levels and assets: e.g. unreal.get_editor_subsystem(unreal.LevelEditorSubsystem).new_level('/Game/Maps/Main') then save_current_level(). print() output comes back.",
        inputSchema: { type: "object", properties: { code: { type: "string" } }, required: ["code"] },
      },
      preview: async (input) => `Unreal Python:\n${String(input.code ?? "").slice(0, 2000)}`,
      run: async (input) => {
        const p = await need();
        const e = await engineOf(p.engine);
        const dir = join(p.dir, "Saved", "KesherAI");
        await mkdir(dir, { recursive: true });
        const script = join(dir, "run.py");
        await writeFile(script, String(input.code ?? ""));
        const cmd = join(e.path, "Engine", "Binaries", "Win64", "UnrealEditor-Cmd.exe");
        const r = await runProgram(cmd, [p.file, "-run=pythonscript", `-script=${script}`, "-unattended", "-nop4", "-nosplash", "-stdout", "-FullStdOutLogOutput"], { timeoutMs: 900_000 });
        const py = r.out.split(/\r?\n/).filter((l) => /LogPython|Error|Traceback/i.test(l)).map((l) => l.replace(/^\[[^\]]*\]\[\s*\d+\]/, ""));
        return { output: `${r.code === 0 ? "Ran." : `Exit ${r.code}.`}\n${cut((py.length ? py : r.out.split("\n").slice(-40)).join("\n"))}` };
      },
    },
    {
      risk: "exec",
      spec: { name: "unreal_open_editor", description: "Open the project in the Unreal Editor so the user can see it (and, in 5.8, its MCP tools appear). Compile first.", inputSchema: { type: "object", properties: {} } },
      preview: async () => `Open ${state.project ?? "(no project)"} in Unreal`,
      run: async () => {
        const p = await need();
        const e = await engineOf(p.engine);
        spawn(join(e.path, "Engine", "Binaries", "Win64", "UnrealEditor.exe"), [p.file], { detached: true, stdio: "ignore" }).unref();
        return { output: `Opening ${p.file} in Unreal ${e.version}. It takes a minute or more the first time (shaders).` };
      },
    },
    {
      risk: "exec",
      spec: {
        name: "unreal_package",
        description: "Build, cook and package the game (RunUAT BuildCookRun) for android (an .apk) or windows. Only when the user asks for a build. Long: the first Android build can take 30+ minutes. Output: <project>/Builds/.",
        inputSchema: { type: "object", properties: { target: { type: "string", enum: ["android", "windows"] } } },
      },
      preview: async (input) => `RunUAT BuildCookRun ${String(input.target ?? "windows")} (${state.project ?? "no project"})`,
      run: async (input, ctx) => {
        const p = await need();
        const e = await engineOf(p.engine);
        const android = input.target === "android";
        const out = join(p.dir, "Builds");
        await mkdir(logsDir, { recursive: true });
        const log = join(logsDir, "unreal-package.log");
        const env: NodeJS.ProcessEnv = { ...process.env };
        if (android) {
          const a = await androidTools();
          if (!a.sdk || !a.ndk || !a.jdk) return { output: `Android tools are missing: SDK ${a.sdk ?? "missing"}, NDK ${a.ndk ?? "missing"}, JDK ${a.jdk ?? "missing"}. Install Android Studio, or Unity's Android module, then try again.` };
          Object.assign(env, { ANDROID_HOME: a.sdk, ANDROID_SDK_ROOT: a.sdk, NDKROOT: a.ndk, NDK_ROOT: a.ndk, JAVA_HOME: a.jdk });
        }
        const args = ["BuildCookRun", `-project=${p.file}`, "-noP4", `-platform=${android ? "Android" : "Win64"}`, ...(android ? ["-cookflavor=ASTC"] : []), "-clientconfig=Development", "-build", "-cook", "-stage", "-pak", "-iostore", "-package", "-archive", `-archivedirectory=${out}`, "-unattended", "-utf8output"];
        await writeFile(log, `> RunUAT ${args.join(" ")}\n`);
        const r = await longRun(`unreal-package:${p.file}:${android ? "android" : "windows"}`, join(e.path, "Engine", "Build", "BatchFiles", "RunUAT.bat"), args, { env, timeoutMs: 3 * 3_600_000, log, signal: ctx?.signal });
        const made: string[] = [];
        const walk = async (d: string, depth: number) => {
          for (const x of await readdir(d, { withFileTypes: true }).catch(() => [])) {
            if (x.isDirectory() && depth < 4) await walk(join(d, x.name), depth + 1);
            else if (x.isFile() && (android ? /\.apk$/i : /\.exe$/i).test(x.name)) made.push(join(d, x.name));
          }
        };
        await walk(out, 0);
        if (r.code !== 0 || !made.length) {
          const errors = r.out.split(/\r?\n/).filter((l) => /\berror\b|failed|exception/i.test(l)).slice(-40);
          return { output: `${r.note}Packaging did NOT finish (exit ${r.code}). Full log: ${log}\n${cut((errors.length ? errors : r.out.split("\n").slice(-60)).join("\n"))}` };
        }
        const sizes = await Promise.all(made.map(async (f) => `${f} (${Math.round((await stat(f)).size / 1048576)} MB)`));
        return { output: `${r.note}Packaged: ${sizes.join(", ")}.` };
      },
    },
  ];
}

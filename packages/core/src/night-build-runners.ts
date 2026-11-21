import { spawn, execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { SMOKE_SECONDS, type NightPlatform, type NightRequest, type NightRun, type NightRunner } from "./night-build.js";
import { engineFor, androidTools, runProgram } from "./unreal-tools.js";
import { findEngines, readProject } from "./unreal-install.js";
import { listPlans, loadPlan } from "./play-test.js";
import type { UnityCli } from "./unity-cli.js";

/**
 * The real builds of the night builds (night-build.ts): Unreal with RunUAT BuildCookRun and Unity with its CLI, both
 * headless, the game written outside the project. The smoke test is the project's saved gameplay test on Unreal when
 * it has one, else the generic one: start the built game and watch that it stays up for {@link SMOKE_SECONDS}.
 */

const execFileP = promisify(execFile);

/**
 * The total size of a folder's files (or one file).
 *
 * @param path - The folder or file.
 * @param depth - How deep to look (a built game is a few levels).
 */
export async function folderBytes(path: string, depth = 8): Promise<number> {
  const st = await stat(path).catch(() => undefined);
  if (!st) return 0;
  if (!st.isDirectory()) return st.size;
  if (depth < 0) return 0;
  let sum = 0;
  for (const e of await readdir(path).catch(() => [] as string[])) sum += await folderBytes(join(path, e), depth - 1);
  return sum;
}

/** The first game executable under a folder (shallowest first), leaving out Unreal's helper programs. */
export async function findGameExe(dir: string, depth = 4): Promise<string | undefined> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const skip = /crash|cef|unins|redist|prereq|setup|helper/i;
  const exe = entries.find((e) => e.isFile() && /\.exe$/i.test(e.name) && !skip.test(e.name));
  if (exe) return join(dir, exe.name);
  if (depth <= 0) return undefined;
  for (const e of entries) if (e.isDirectory()) {
    const f = await findGameExe(join(dir, e.name), depth - 1);
    if (f) return f;
  }
  return undefined;
}

/** What the generic smoke test needs from the system (tests give their own). */
export interface SmokeSpawn {
  (file: string): { onExit: (cb: (code: number | null, signal: string | null) => void) => void; kill: () => void };
}

const realSpawn: SmokeSpawn = (file) => {
  const c = spawn(file, [], { stdio: "ignore", windowsHide: false });
  return { onExit: (cb) => { c.on("exit", cb); c.on("error", () => cb(-1, null)); }, kill: () => void c.kill() };
};

/**
 * The generic smoke test: starts the built game and watches it. It passes when the game is still running after
 * `seconds`; it fails when the game ends sooner (a crash, or a start that was refused).
 *
 * @param exe - The built game.
 * @param seconds - How long to watch.
 * @param start - Starts a program (tests give their own).
 */
export async function smokeLaunch(exe: string, seconds: number, start: SmokeSpawn = realSpawn): Promise<{ ok: boolean; note: string }> {
  const t0 = Date.now();
  const p = start(exe);
  return new Promise((res) => {
    let done = false;
    const finish = (r: { ok: boolean; note: string }) => { if (!done) { done = true; clearTimeout(timer); res(r); } };
    const timer = setTimeout(() => { p.kill(); finish({ ok: true, note: `Stayed up ${seconds} s` }); }, seconds * 1000);
    p.onExit((code, signal) => finish({ ok: false, note: `Ended after ${Math.round((Date.now() - t0) / 1000)} s (${signal ?? `exit ${code}`})` }));
  });
}

/** The play test result the plugin writes: only `passed` and `reason` matter here. */
const playOk = (r: unknown): { ok: boolean; note: string } => {
  const x = (r && typeof r === "object" ? r : {}) as { passed?: boolean; reason?: string };
  return { ok: x.passed === true, note: x.passed ? "Play test passed" : `Play test failed${x.reason ? `: ${x.reason}` : ""}` };
};

/** What the Unreal runner may use besides the engine. */
export interface UnrealRunnerDeps {
  /** Runs a saved gameplay test headless (UnrealBridge.playHeadlessFor). */
  playTest?: (projectFile: string, plan: unknown) => Promise<unknown>;
}

/**
 * The Unreal runner: RunUAT BuildCookRun for Windows or Android, as the `unreal_package` tool does but with the game
 * written to the night folder.
 *
 * @param d - The saved-play-test runner.
 */
export function unrealRunner(d: UnrealRunnerDeps = {}): NightRunner {
  return async (r: NightRequest): Promise<NightRun> => {
    const p = await readProject(r.project);
    const e = engineFor(await findEngines(), p.engine);
    if (!e) return { ok: false, log: `Error: Unreal ${p.engine} is not installed on this computer.` };
    const android = r.platform === "android";
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (android) {
      const a = await androidTools();
      if (!a.sdk || !a.ndk || !a.jdk) return { ok: false, log: "Error: the Android tools are missing (SDK, NDK or JDK)." };
      Object.assign(env, { ANDROID_HOME: a.sdk, ANDROID_SDK_ROOT: a.sdk, NDKROOT: a.ndk, NDK_ROOT: a.ndk, JAVA_HOME: a.jdk });
    }
    await mkdir(r.outDir, { recursive: true });
    const args = ["BuildCookRun", `-project=${p.file}`, "-noP4", `-platform=${android ? "Android" : "Win64"}`, ...(android ? ["-cookflavor=ASTC"] : []), "-clientconfig=Development", "-build", "-cook", "-stage", "-pak", "-iostore", "-package", "-archive", `-archivedirectory=${r.outDir}`, "-unattended", "-utf8output"];
    const run = await runProgram(join(e.path, "Engine", "Build", "BatchFiles", "RunUAT.bat"), args, { env, timeoutMs: 3 * 3_600_000, log: r.logFile });
    const exe = android ? undefined : await findGameExe(r.outDir);
    const made = android ? (await readdir(r.outDir, { recursive: true }).catch(() => [] as string[])).some((f) => /\.apk$/i.test(String(f))) : !!exe;
    const ok = run.code === 0 && made;
    const out: NightRun = { ok, log: run.out, ...(ok ? { sizeBytes: await folderBytes(r.outDir) } : {}) };
    if (ok && r.smoke) {
      const plans = await listPlans(p.dir).catch(() => []);
      if (plans[0] && d.playTest) out.smoke = playOk(await d.playTest(p.file, await loadPlan(p.dir, plans[0].name)).catch((x: unknown) => ({ passed: false, reason: x instanceof Error ? x.message : String(x) })));
      else if (exe) out.smoke = await smokeLaunch(exe, SMOKE_SECONDS);
    }
    return out;
  };
}

/** Unity's build targets for the platforms. */
const UNITY_TARGET: Record<NightPlatform, { id: string; file: (name: string) => string }> = {
  windows: { id: "StandaloneWindows64", file: (n) => `${n}.exe` },
  android: { id: "Android", file: (n) => `${n}.apk` },
};

/**
 * The Unity runner: the CLI's `build` command with the editor closed, the game written to the night folder.
 *
 * @param unity - The Unity CLI.
 */
export function unityRunner(unity: Pick<UnityCli, "cliRaw">): NightRunner {
  return async (r: NightRequest): Promise<NightRun> => {
    const t = UNITY_TARGET[r.platform];
    await mkdir(r.outDir, { recursive: true });
    const name = r.name.replace(/[^\w -]/g, "").trim() || "Game";
    const out = join(r.outDir, t.file(name));
    const run = await unity.cliRaw(["build", r.project, "--target", t.id, "--output-path", out, "--timeout", "3600", "--format", "json"], 3_700_000);
    const log = `${run.stdout}\n${run.stderr}`.trim();
    const ok = run.code === 0 && existsSync(out);
    const res: NightRun = { ok, log, ...(ok ? { sizeBytes: await folderBytes(r.outDir) } : {}) };
    if (ok && r.smoke && r.platform === "windows") res.smoke = await smokeLaunch(out, SMOKE_SECONDS);
    return res;
  };
}

/**
 * The platforms a project can build on this computer: Windows (on Windows), Android when its tools or Unity's module
 * are installed.
 *
 * @param engine - The project's engine.
 * @param version - Its Unity version (ProjectSettings/ProjectVersion.txt) for the module check.
 */
export async function platformsFor(engine: "unity" | "unreal", version?: string): Promise<NightPlatform[]> {
  const out: NightPlatform[] = process.platform === "win32" ? ["windows"] : [];
  if (engine === "unreal") {
    const a = await androidTools().catch(() => undefined);
    if (a?.sdk && a.ndk && a.jdk) out.push("android");
  } else if (version) {
    const hub = join(process.env.ProgramFiles ?? "C:\\Program Files", "Unity", "Hub", "Editor", version, "Editor", "Data", "PlaybackEngines", "AndroidPlayer");
    if (existsSync(hub)) out.push("android");
  }
  return out;
}

/**
 * The commits since the last night build (short hash and subject, newest first) and HEAD now. Not a git folder: none.
 *
 * @param project - The project folder.
 * @param since - The commit of the last build (a hex hash only, else the last five commits are listed).
 */
export async function gitChanges(project: string, since?: string): Promise<{ head?: string; lines: string[] }> {
  const git = (args: string[]) => execFileP("git", ["-C", project, ...args], { timeout: 15_000, windowsHide: true }).then((r) => r.stdout.trim(), () => "");
  const head = await git(["rev-parse", "HEAD"]);
  if (!/^[0-9a-f]{40}$/.test(head)) return { lines: [] };
  const range = since && /^[0-9a-f]{40}$/.test(since) && since !== head ? [`${since}..HEAD`] : ["-n", "5"];
  const log = await git(["log", "--pretty=format:%h %s", "-n", "30", ...range]);
  return { head, lines: log ? log.split(/\r?\n/).map((l) => l.slice(0, 160)) : [] };
}

/** Reads a Unity project's version text. */
export const unityVersionOf = async (project: string): Promise<string | undefined> => /m_EditorVersion:\s*([\w.]+)/.exec(await readFile(join(project, "ProjectSettings", "ProjectVersion.txt"), "utf8").catch(() => ""))?.[1];

/**
 * Whether an Unreal editor (not the command-line one) has this project open, from the running programs' command lines.
 *
 * @param uprojectDir - The project folder.
 */
export async function unrealEditorOpenOn(uprojectDir: string): Promise<boolean> {
  const file = (await readProject(uprojectDir).catch(() => undefined))?.file;
  if (!file) return false;
  const name = file.split(/[\\/]/).pop()!.toLowerCase();
  const r = process.platform === "win32"
    ? await runProgram("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Get-CimInstance Win32_Process -Filter \"Name='UnrealEditor.exe'\" | ForEach-Object { $_.CommandLine }"], { timeoutMs: 15_000 }).catch(() => ({ code: 1, out: "" }))
    : await runProgram("ps", ["-eo", "args"], { timeoutMs: 10_000 }).catch(() => ({ code: 1, out: "" }));
  return r.out.split(/\r?\n/).some((l) => /UnrealEditor(?!-Cmd)/i.test(l) && l.toLowerCase().includes(name));
}

/**
 * How the task inbox starts its programs (server/build-inbox.ts): which program, which arguments, and whether a shell
 * is used. Kept apart from the spawning itself so the Windows rules can be tested on any system.
 *
 * - git always runs as the git program itself (never a shell), so its arguments (branch names, paths, task text in a
 *   commit message) are never read by cmd.exe. Before 0.6.407 the inbox handed `["fetch", …]` to a runner that took
 *   the first argument as the program, and on Windows ran it through cmd.exe: "'fetch' is not recognized".
 * - Check commands (`["pnpm", "-s", "test"]`) need a shell on Windows only for `.cmd` programs such as pnpm; their
 *   arguments must then hold no shell syntax.
 */
import { existsSync } from "node:fs";
import { win32 } from "node:path";
import { INBOX_GIT_MISSING } from "@kesher/shared";

/** The program, its arguments and whether a shell runs it. */
export interface SpawnPlan {
  program: string;
  args: string[];
  shell: boolean;
}

/** Characters cmd.exe would read as syntax; a check command with any of them is refused on Windows. */
const SHELL_SYNTAX = /[&|<>^%"`;()]/;

/**
 * Finds git: on Windows, git.exe on PATH, then the usual Git for Windows folders (an app started from the Start menu
 * may have an older PATH than a new install); elsewhere just "git" (looked up on PATH by the system).
 *
 * @param platform - The system (process.platform).
 * @param env - The environment (PATH, ProgramFiles, LOCALAPPDATA).
 * @param exists - Whether a file exists (injected for tests).
 * @returns The program to start; "git" when no full path was found (starting it then fails with ENOENT).
 */
export function findGit(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env, exists: (p: string) => boolean = existsSync): string {
  if (platform !== "win32") return "git";
  // Windows names its PATH variable "Path"; look it up without caring about case.
  const pathKey = Object.keys(env).find((k) => k.toUpperCase() === "PATH");
  const dirs = (pathKey ? env[pathKey] ?? "" : "").split(";").map((d) => d.trim().replace(/^"(.*)"$/, "$1")).filter(Boolean);
  const roots = [env.ProgramW6432, env.ProgramFiles, env["ProgramFiles(x86)"], env.LOCALAPPDATA && win32.join(env.LOCALAPPDATA, "Programs")].filter((r): r is string => !!r);
  const candidates = [...dirs.map((d) => win32.join(d, "git.exe")), ...roots.map((r) => win32.join(r, "Git", "cmd", "git.exe"))];
  return candidates.find((c) => exists(c)) ?? "git";
}

/**
 * Plans a git run: the git program with exactly these arguments, never a shell.
 *
 * @param git - The git program ({@link findGit}).
 * @param args - git's arguments, starting with the git command (`["fetch", "--quiet", …]`).
 * @returns The plan.
 */
export function gitPlan(git: string, args: string[]): SpawnPlan {
  return { program: git, args: [...args], shell: false };
}

/**
 * Plans a check command: the first argument is the program. On Windows a program other than git runs through cmd.exe
 * (so `pnpm.cmd` is found), and then any shell syntax in the arguments is refused.
 *
 * @param args - The program and its arguments.
 * @param platform - The system (process.platform).
 * @returns The plan, or why it was refused.
 */
export function commandPlan(args: string[], platform: NodeJS.Platform = process.platform): SpawnPlan | { refused: string } {
  const [program, ...rest] = args;
  if (!program) return { refused: "No command." };
  const shell = platform === "win32" && !/^git(\.exe)?$/i.test(program);
  if (shell && args.some((a) => SHELL_SYNTAX.test(a))) return { refused: "Refused: shell characters." };
  return { program, args: rest, shell };
}

/**
 * The text for a program that could not be started: for git, {@link INBOX_GIT_MISSING} (the page explains it in Hebrew
 * and English); otherwise the system's message.
 *
 * @param err - The spawn error.
 * @param isGit - Whether the program was git.
 */
export function startErrorText(err: NodeJS.ErrnoException, isGit: boolean): string {
  return isGit && err.code === "ENOENT" ? INBOX_GIT_MISSING : err.message;
}

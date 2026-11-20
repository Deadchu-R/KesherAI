import assert from "node:assert/strict";
import { test } from "node:test";
import { INBOX_GIT_MISSING } from "@kesher/shared";
import { commandPlan, findGit, gitPlan, startErrorText } from "./inbox-spawn.js";

test("git runs as the git program, never through a shell, on Windows too", () => {
  // The bug: `["fetch", …]` became the program and cmd.exe said "'fetch' is not recognized".
  const plan = gitPlan("C:\\Program Files\\Git\\cmd\\git.exe", ["fetch", "--quiet", "--no-tags", "origin", "+refs/heads/main:refs/remotes/origin/main"]);
  assert.equal(plan.program, "C:\\Program Files\\Git\\cmd\\git.exe");
  assert.deepEqual(plan.args.slice(0, 2), ["fetch", "--quiet"]);
  assert.equal(plan.shell, false);
  // Shell syntax in git's arguments (a commit message, a path) is safe: no shell reads it.
  assert.deepEqual(gitPlan("git", ["commit", "-m", "a & b | c"]).args, ["commit", "-m", "a & b | c"]);
});

test("findGit: PATH first, then the Git for Windows folders, else plain git", () => {
  const env = { Path: "C:\\Windows;\"C:\\Tools\\Git\\cmd\"", ProgramFiles: "C:\\Program Files", LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" };
  assert.equal(findGit("win32", env, (p) => p === "C:\\Tools\\Git\\cmd\\git.exe"), "C:\\Tools\\Git\\cmd\\git.exe");
  assert.equal(findGit("win32", env, (p) => p === "C:\\Program Files\\Git\\cmd\\git.exe"), "C:\\Program Files\\Git\\cmd\\git.exe");
  assert.equal(findGit("win32", env, (p) => p === "C:\\Users\\u\\AppData\\Local\\Programs\\Git\\cmd\\git.exe"), "C:\\Users\\u\\AppData\\Local\\Programs\\Git\\cmd\\git.exe");
  assert.equal(findGit("win32", env, () => false), "git");
  assert.equal(findGit("linux", { PATH: "/usr/bin" }, () => true), "git");
});

test("check commands: a shell on Windows only for non-git programs, and no shell syntax then", () => {
  assert.deepEqual(commandPlan(["pnpm", "-s", "test"], "win32"), { program: "pnpm", args: ["-s", "test"], shell: true });
  assert.deepEqual(commandPlan(["pnpm", "-s", "test"], "linux"), { program: "pnpm", args: ["-s", "test"], shell: false });
  assert.equal((commandPlan(["Git.exe", "status"], "win32") as { shell: boolean }).shell, false);
  assert.deepEqual(commandPlan(["pnpm", "test", "&", "del", "x"], "win32"), { refused: "Refused: shell characters." });
  assert.deepEqual(commandPlan([], "win32"), { refused: "No command." });
});

test("a missing git reads as INBOX_GIT_MISSING, not the system message", () => {
  const enoent = Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" });
  assert.equal(startErrorText(enoent, true), INBOX_GIT_MISSING);
  assert.equal(startErrorText(enoent, false), "spawn git ENOENT");
});

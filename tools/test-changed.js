#!/usr/bin/env node
/* global process, console */
/**
 * Run tests only for files that changed since the last commit (or working tree).
 *
 * Usage:
 *   node tools/test-changed.js              # tests for unstaged + staged changes
 *   node tools/test-changed.js --staged     # tests for staged changes only
 *   node tools/test-changed.js --since HEAD~3  # tests for changes in last 3 commits
 *
 * Finds changed source files, matches them to *.test.ts files in the same folder,
 * and runs `node --test` on the matching test files.
 *
 * Requires git. Falls back to running all tests if git is unavailable.
 */

import { execSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join, dirname, basename } from "node:path";

// --- helpers ---

/** Build a PATH that includes node_modules/.bin so tsx and git resolve on Windows. */
function buildPath() {
  const sep = process.platform === "win32" ? ";" : ":";
  const bin = join(process.cwd(), "node_modules", ".bin");
  return [bin, process.env.PATH].filter(Boolean).join(sep);
}
const execEnv = { ...process.env, PATH: buildPath() };

/** Run a shell command and return stdout as a string. */
function sh(cmd, opts) {
  try {
    return execSync(cmd, { cwd: process.cwd(), encoding: "utf-8", env: execEnv, ...opts });
  } catch {
    return "";
  }
}

/** List changed files from git. */
function changedFiles(mode) {
  if (mode === "staged") {
    return sh("git diff --name-only --diff-filter=ACMR --staged");
  }
  if (mode.startsWith("since ")) {
    const ref = mode.slice(6).trim();
    return sh(`git diff --name-only --diff-filter=ACMR ${ref}`);
  }
  // default: staged + unstaged (working tree)
  return sh("git diff --name-only --diff-filter=ACMR") + "\n" + sh("git diff --name-only --diff-filter=ACMR --staged");
}

/** Collect all .ts files under a folder to build a lookup. */
function collectTsFiles(dir, list = []) {
  if (!dir) return list;
  let st;
  try {
    st = statSync(dir);
  } catch {
    return list;
  }
  if (!st.isDirectory()) return list;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (entry === "node_modules" || entry === ".git" || entry === "dist" || entry === "build") continue;
      collectTsFiles(full, list);
    } else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) {
      list.push(full);
    }
  }
  return list;
}

/**
 * Given a set of changed file paths, return the set of test files to run.
 *
 * Rules:
 * - If a *.test.ts file itself changed, include it.
 * - If a *.ts source file changed, look for a *.test.ts with the same base name
 *   in the same directory.
 * - If no specific test file is found, include all tests in that directory.
 */
function findTestsToRun(changedSet, tsFiles) {
  const tests = new Set();

  for (const file of changedSet) {
    if (file.endsWith(".test.ts")) {
      tests.add(file);
      continue;
    }
    if (!file.endsWith(".ts")) continue;

    const dir = dirname(file);
    const base = basename(file, ".ts");
    const exactTest = join(dir, base + ".test.ts");

    if (tsFiles.includes(exactTest)) {
      tests.add(exactTest);
    } else {
      // Run all tests in the same directory as a fallback
      for (const tf of tsFiles) {
        if (dirname(tf) === dir && tf.endsWith(".test.ts")) {
          tests.add(tf);
        }
      }
    }
  }

  return tests;
}

// --- main ---

function main() {
  const args = process.argv.slice(2);
  let mode = "working";

  if (args.includes("--staged")) mode = "staged";
  else if (args.includes("--since")) {
    const idx = args.indexOf("--since");
    if (idx + 1 < args.length) mode = "since " + args[idx + 1];
  }

  // Check git is available
  const gitOk = sh("git rev-parse --is-inside-work-tree 2>/dev/null").trim() === "true";
  if (!gitOk) {
    console.error("Not a git repo (or git not found). Running all tests as fallback.");
    execSync("tsx --test packages/**/*.test.ts packages/**/**/*.test.ts", {
      stdio: "inherit",
      env: execEnv,
      shell: true,
    });
    process.exit(0);
  }

  const raw = changedFiles(mode);
  const changedSet = new Set(raw.split("\n").map(s => s.trim()).filter(Boolean));

  if (changedSet.size === 0) {
    console.log("No changed files. Nothing to test.");
    process.exit(0);
  }

  // Collect all .ts files for lookup
  const tsFiles = [];
  for (const pkg of ["packages", "tools"]) {
    collectTsFiles(pkg, tsFiles);
  }

  const testsToRun = findTestsToRun(changedSet, tsFiles);

  if (testsToRun.size === 0) {
    console.log(`Changed ${changedSet.size} file(s) but no matching test files found.`);
    console.log("Changed files:");
    for (const f of changedSet) console.log("  " + f);
    process.exit(0);
  }

  console.log(`Running ${testsToRun.size} test(s) for ${changedSet.size} changed file(s):\n`);
  for (const t of testsToRun) console.log("  " + t);
  console.log();

  // Run tests via tsx --test (tsx handles .ts -> .js module resolution correctly)
  const testFiles = [...testsToRun];
  const cmd = `tsx --test --test-force-exit --test-timeout=300000 ${testFiles.map(p => JSON.stringify(p)).join(" ")}`;
  try {
    execSync(cmd, { stdio: "inherit", env: execEnv, shell: true });
    console.log("\nAll changed-file tests passed.");
    process.exit(0);
  } catch {
    console.error("\nSome tests failed.");
    process.exit(1);
  }
  }

  main();

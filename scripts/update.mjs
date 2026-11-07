#!/usr/bin/env node
/**
 * Updates a git checkout of KesherAI: pull, install, build.
 *
 * The core server starts this as a separate, detached process so the update
 * keeps going when the server restarts in the middle (the developer version
 * restarts itself as soon as `git pull` changes its files). Progress is
 * written to a JSON file the server reads: `node scripts/update.mjs <status.json>`.
 */
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const statusFile = process.argv[2];
const state = { running: true, step: "", log: [], startedAt: new Date().toISOString() };
const save = () => {
  state.log = state.log.slice(-300);
  try {
    writeFileSync(statusFile, JSON.stringify(state));
  } catch {
    // the server shows nothing new until the next write
  }
};

const steps = [
  ["Downloading the update", "git", ["pull", "--ff-only"]],
  ["Installing dependencies", "pnpm", ["install"]],
  ["Building", "pnpm", ["build:packages"]],
  ["Building the interface", "pnpm", ["--filter", "@kesher/web", "build"]],
  ["Building the desktop app", "pnpm", ["--filter", "@kesher/desktop", "build"]],
];

function run(name, cmd, args) {
  state.step = name;
  state.log.push(`$ ${cmd} ${args.join(" ")}`);
  save();
  return new Promise((ok, fail) => {
    const child = spawn(cmd, args, { cwd: root, shell: true, windowsHide: true, env: { ...process.env, CI: "1" } });
    const onData = (b) => {
      state.log.push(...b.toString().split(/\r?\n/).filter(Boolean));
      save();
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("error", fail);
    child.on("close", (code) => (code === 0 ? ok() : fail(new Error(`${name} failed (exit code ${code})`))));
  });
}

try {
  for (const [name, cmd, args] of steps) await run(name, cmd, args);
  state.step = "Done";
} catch (err) {
  state.error = err instanceof Error ? err.message : String(err);
} finally {
  state.running = false;
  state.finishedAt = new Date().toISOString();
  save();
}

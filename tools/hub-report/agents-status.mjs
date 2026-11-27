#!/usr/bin/env node
/**
 * The lead's one-command status for the Claude agents panel ("Running now" in KesherAI's Settings > Agents and the hub).
 *
 *   node tools/hub-report/agents-status.mjs set  <id> [title] [model] [--note "text"]   an agent started (or got an update)
 *   node tools/hub-report/agents-status.mjs done <id> [--note "text"]                    it finished
 *   node tools/hub-report/agents-status.mjs fail <id> [--note "text"]                    it failed
 *
 * It reads `claude/agents.json` from the `claude-status` branch, applies the change and pushes the branch, without
 * touching the working tree or the current branch (git plumbing only). The branch is not main, so no CI and no release.
 * Run it inside the repository (origin must be reachable). The pure part is tested in agents-status.test.ts.
 */
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

/** The branch and file the PC reads (shared/claude-status.ts has the same names). */
export const BRANCH = "claude-status";
export const FILE = "claude/agents.json";
const MAX = 10;
/** Finished entries older than this are dropped on the next write (ms). */
const KEEP_DONE_MS = 24 * 3_600_000;
const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const line = (v, max) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);

/**
 * Reads the file's text into a list of entries; anything unusable gives an empty list (the script then starts afresh).
 *
 * @param {string | undefined} text - The file's content.
 * @returns {Array<Record<string, unknown>>} The entries.
 */
export function readAgents(text) {
  try {
    const raw = JSON.parse(text ?? "");
    return Array.isArray(raw?.agents) ? raw.agents.filter((a) => a && typeof a === "object" && ID_RE.test(String(a.id))) : [];
  } catch {
    return [];
  }
}

/**
 * Applies one command to the file's entries: `set` creates the entry (running) or refreshes it, `done`/`fail` end it.
 * Finished entries older than a day go; past 10 entries the oldest finished ones go first, then the oldest running.
 *
 * @param {Array<Record<string, unknown>>} agents - The current entries.
 * @param {{cmd: "set" | "done" | "fail", id: string, title?: string, model?: string, note?: string}} c - The command.
 * @param {number} now - The time now (ms).
 * @returns {{updatedAt: number, agents: Array<Record<string, unknown>>}} The new file content.
 */
export function applyUpdate(agents, c, now) {
  if (!ID_RE.test(c.id)) throw new Error("the id is letters, digits, _ and - only (at most 40)");
  const old = agents.find((a) => a.id === c.id);
  const state = c.cmd === "set" ? "running" : c.cmd === "done" ? "done" : "failed";
  const note = c.note ? line(c.note, 200) : c.cmd === "set" ? undefined : old?.lastNote;
  const entry = {
    id: c.id,
    title: line(c.title, 120) || (old?.title ? String(old.title) : c.id),
    model: line(c.model, 40) || (old?.model ? String(old.model) : ""),
    // A restart of a finished id is a new run; a refresh of a running one keeps its start.
    startedAt: old && old.state === "running" && typeof old.startedAt === "number" ? old.startedAt : now,
    state,
    updatedAt: now,
    ...(note ? { lastNote: note } : {}),
  };
  if (c.cmd !== "set" && !old) entry.startedAt = now;
  let list = [...agents.filter((a) => a.id !== c.id && !(a.state !== "running" && now - (a.updatedAt ?? a.startedAt ?? 0) > KEEP_DONE_MS)), entry];
  while (list.length > MAX) {
    const drop = list.findIndex((a) => a.id !== c.id && a.state !== "running") >= 0 ? list.findIndex((a) => a.id !== c.id && a.state !== "running") : list.findIndex((a) => a.id !== c.id);
    list.splice(drop, 1);
  }
  return { updatedAt: now, agents: list };
}

/**
 * Splits the command line into the command, the id, the positional title/model and `--note`.
 *
 * @param {string[]} argv - The arguments after the script's name.
 */
export function parseArgs(argv) {
  const pos = [];
  let note;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--note") note = argv[++i];
    else pos.push(argv[i]);
  }
  const [cmd, id, title, model] = pos;
  if (!["set", "done", "fail"].includes(cmd) || !id) throw new Error("usage: agents-status.mjs set|done|fail <id> [title] [model] [--note text]");
  return { cmd, id, title, model, note };
}

/** Runs git with these arguments; returns its output, or undefined when it fails. */
function git(args, input) {
  try {
    return execFileSync("git", args, { encoding: "utf8", input, stdio: ["pipe", "pipe", "pipe"] }).trim();
  } catch {
    return undefined;
  }
}

/** Writes the file as a commit on top of the branch's tip (plumbing: the working tree is not touched) and pushes it. */
function commitAndPush(json, parent) {
  const blob = git(["hash-object", "-w", "--stdin"], json);
  const sub = git(["mktree"], `100644 blob ${blob}\tagents.json\n`);
  const root = git(["mktree"], `040000 tree ${sub}\tclaude\n`);
  if (!blob || !sub || !root) throw new Error("git could not write the file");
  const msg = "Agents status";
  const id = ["-c", "user.name=Roee Tal", "-c", "user.email=Deadchu-R@users.noreply.github.com"];
  const commit = git([...id, "commit-tree", root, ...(parent ? ["-p", parent] : []), "-m", msg]);
  if (!commit) throw new Error("git could not make the commit");
  return git(["push", "--quiet", "origin", `${commit}:refs/heads/${BRANCH}`]) !== undefined;
}

/** The CLI: fetch the branch, apply, push; one retry when the push loses a race. */
function main() {
  const c = parseArgs(process.argv.slice(2));
  for (let attempt = 0; attempt < 2; attempt++) {
    git(["fetch", "--quiet", "--no-tags", "origin", `+refs/heads/${BRANCH}:refs/remotes/origin/${BRANCH}`]);
    const parent = git(["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${BRANCH}`]);
    const text = parent ? git(["show", `${parent}:${FILE}`]) : undefined;
    const next = applyUpdate(readAgents(text), c, Date.now());
    if (commitAndPush(JSON.stringify(next, null, 2) + "\n", parent)) {
      console.log(`${c.cmd} ${c.id}: ${next.agents.filter((a) => a.state === "running").length} running`);
      return;
    }
  }
  throw new Error("the push to the claude-status branch failed twice");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}

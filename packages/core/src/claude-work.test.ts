import { test } from "node:test";
import assert from "node:assert/strict";
import { ClaudeWorkReader } from "./claude-work.js";
import type { GitRun } from "./external-agents.js";

const NOW = Date.UTC(2026, 10, 28, 12, 0);
const sec = (ms: number) => Math.floor(ms / 1000);
const LOG = `\x1e${"a".repeat(40)}\x1f${sec(NOW - 3600_000)}\x1fAdd panel\n\nClaude-Session: https://claude.ai/code/session_X\n\x1f\nf1.ts\nf2.ts\n`;

test("reader: one git log per HEAD, session rows with the commit page, no project or a git failure give an empty list", async () => {
  const calls: string[][] = [];
  const git: GitRun = async (a) => {
    calls.push(a);
    return a[0] === "rev-parse" ? "h1\n" : a[0] === "config" ? "git@github.com:o/r.git\n" : LOG;
  };
  const r = new ClaudeWorkReader(() => git, () => NOW);
  const w = await r.read();
  assert.equal(w.sessions.length, 1);
  assert.equal(w.sessions[0]!.commits[0]!.files, 2);
  assert.equal(w.sessions[0]!.commits[0]!.url, `https://github.com/o/r/commit/${"a".repeat(40)}`);
  const n = calls.length;
  await r.read();
  assert.equal(calls.length, n + 1, "the second read only asks for HEAD");
  assert.deepEqual((await new ClaudeWorkReader(() => undefined).read()).sessions, []);
  assert.deepEqual((await new ClaudeWorkReader(() => async () => { throw new Error("no git"); }).read()).sessions, []);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SelfWork, readOutcome, type SelfWorkDeps } from "./self-work.js";

test("reads the model's outcome line", () => {
  assert.deepEqual(readOutcome("did it\n**ITEM DONE: add the button**"), { kind: "item", text: "add the button" });
  assert.deepEqual(readOutcome("ALL DONE"), { kind: "all", text: "" });
  assert.deepEqual(readOutcome("x\nBLOCKED: needs a token"), { kind: "blocked", text: "needs a token" });
  assert.equal(readOutcome("just talking").kind, "none");
});

async function setup(answers: string[], opts: { dirty?: boolean; checks?: number[]; changed?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "selfwork-"));
  const repo = join(root, "repo");
  await mkdir(join(repo, ".git"), { recursive: true });
  const git: string[][] = [];
  const sent: string[] = [];
  const notes: string[] = [];
  const checks = [...(opts.checks ?? [])];
  let turn = -1;
  const d: SelfWorkDeps = {
    createChat: async () => "c1",
    send: async (_id, text) => {
      sent.push(text);
      turn++;
    },
    state: async () => ({ status: "idle", last: answers[Math.min(turn, answers.length - 1)] ?? "" }),
    git: async (_r, args) => {
      git.push(args);
      if (args[0] === "rev-parse" && args[1] === "--verify") return opts.dirty ? { code: 128, out: "fatal: no commits yet" } : { code: 0, out: "abc\n" };
      if (args[0] === "rev-parse") return { code: 0, out: `abc${git.length}\n` };
      if (args[0] === "status") return { code: 0, out: opts.changed ? " M src/a.ts\n" : "" };
      return { code: 0, out: "" };
    },
    check: async () => ({ code: checks.shift() ?? 0, out: "1 test failed" }),
    notify: async (title) => void notes.push(title),
    sleep: async () => undefined,
  };
  return { sw: new SelfWork(join(root, "selfwork.json"), d), repo, git, sent, notes };
}

test("works item by item on its own branch, checks, commits, and ends when done", async () => {
  const { sw, repo, git, sent, notes } = await setup(["plan written\nITEM DONE: plan", "ITEM DONE: add parser", "ALL DONE: goal met"]);
  const r = await sw.start({ repo, goal: "add a parser", check: "pnpm test", hours: 1 });
  assert.match(r.branch, /^kesher-self\/\d{12}$/);
  await sw.settled();
  const wt = git.find((a) => a[0] === "worktree")!;
  assert.deepEqual(wt.slice(0, 4), ["worktree", "add", "-b", r.branch]);
  assert.match(r.worktree, /repo-self-work[\\/]\d{12}$/, "a separate folder next to the project");
  assert.equal(git.filter((a) => a[0] === "commit").length, 3);
  assert.ok(!git.some((a) => a[0] === "push" || a[0] === "merge"), "never pushes or merges");
  assert.equal(sw.current?.status, "done");
  assert.equal(sw.current?.items.length, 3);
  assert.match(sent[0]!, /ITEM DONE/);
  assert.ok(notes.includes("✅ Self-work finished"));
});

test("refuses a project git cannot read, and stops after 3 failed checks", async () => {
  const dirty = await setup(["ITEM DONE: x"], { dirty: true });
  await assert.rejects(dirty.sw.start({ repo: dirty.repo, goal: "x" }), /git could not read/);

  const failing = await setup(["ITEM DONE: x"], { checks: [1, 1, 1] });
  await failing.sw.start({ repo: failing.repo, goal: "x", check: "pnpm test" });
  await failing.sw.settled();
  assert.equal(failing.sw.current?.status, "blocked");
  assert.equal(failing.git.filter((a) => a[0] === "commit").length, 0, "nothing committed while the check fails");
  assert.match(failing.sent[1]!, /failed after your change/);
});

test("a BLOCKED answer ends the run and tells the user", async () => {
  const { sw, repo, notes } = await setup(["BLOCKED: which database?"]);
  await sw.start({ repo, goal: "x" });
  await sw.settled();
  assert.equal(sw.current?.status, "blocked");
  assert.equal(sw.current?.note, "which database?");
  assert.ok(notes.includes("✋ Self-work needs you"));
});

test("a turn that changed files but forgot the closing line is checked and committed, not counted as a failure", async () => {
  const { sw, repo, git } = await setup(["I have successfully completed the refactoring.", "ALL DONE"], { changed: true });
  await sw.start({ repo, goal: "refactor", check: "pnpm test", hours: 1 });
  await sw.settled();
  assert.equal(sw.current?.status, "done");
  assert.equal(sw.current?.items[0]?.text, "Changes (the model did not name the item)");
  assert.ok(git.some((a) => a[0] === "commit"));
});

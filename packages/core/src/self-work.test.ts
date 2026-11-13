import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitItem, REVIEW, SelfWork, readOutcome, tickedItem, type SelfWorkDeps } from "./self-work.js";

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

test("refuses a project git cannot read; after 3 failed checks it undoes the item and goes on with the next", async () => {
  const dirty = await setup(["ITEM DONE: x"], { dirty: true });
  await assert.rejects(dirty.sw.start({ repo: dirty.repo, goal: "x" }), /git could not read/);

  const failing = await setup(["ITEM DONE: x", "ITEM DONE: x", "ITEM DONE: x", "ALL DONE"], { checks: [1, 1, 1, 0] });
  await failing.sw.start({ repo: failing.repo, goal: "x", check: "pnpm test" });
  await failing.sw.settled();
  assert.match(failing.sent[1]!, /failed after your change/);
  assert.match(failing.sw.current?.skipped?.[0]?.why ?? "", /failed 3 times/);
  const reset = failing.git.findIndex((a) => a[0] === "reset");
  assert.ok(reset >= 0, "the failed item's changes are undone");
  assert.equal(failing.git.slice(0, reset).filter((a) => a[0] === "commit").length, 0, "nothing committed while the check fails");
  assert.ok(failing.sent.some((m) => /could not be finished/.test(m)), "the model is told to go on with the next item");
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

test("a stuck turn (nothing new for 12 minutes) is stopped and the item resumed", async () => {
  const root = await mkdtemp(join(tmpdir(), "selfwork-"));
  const repo = join(root, "repo");
  await mkdir(join(repo, ".git"), { recursive: true });
  let clock = 0;
  let turn = -1;
  const stopped: string[] = [];
  const sent: string[] = [];
  const sw = new SelfWork(join(root, "selfwork.json"), {
    createChat: async () => "c1",
    send: async (_id, text) => {
      sent.push(text);
      turn++;
    },
    // The first turn never moves (same event count) and never ends; the next one finishes.
    state: async () => (turn === 0 ? { status: "running", last: "", events: 5 } : { status: "idle", last: "ALL DONE", events: 9 }),
    stopTurn: (id) => void stopped.push(id),
    git: async (_r, args) => ({ code: 0, out: args[0] === "rev-parse" ? "abc\n" : "" }),
    check: async () => ({ code: 0, out: "" }),
    notify: async () => undefined,
    sleep: async () => void (clock += 60_000),
    now: () => clock,
  });
  await sw.start({ repo, goal: "x", hours: 2 });
  await sw.settled();
  assert.deepEqual(stopped, ["c1"]);
  assert.ok(sent.some((m) => /ended with an error. Continue/.test(m)), "the item is resumed");
  assert.equal(sw.current?.status, "done");
});

test("a run that ended can be resumed where it stopped", async () => {
  const { sw, repo, sent } = await setup(["BLOCKED: which database?", "BLOCKED: which database?", "BLOCKED: which database?", "BLOCKED: which database?", "ALL DONE"]);
  const r = await sw.start({ repo, goal: "x" });
  await mkdir(r.worktree!, { recursive: true });
  await sw.settled();
  assert.equal(sw.current?.status, "blocked");
  await assert.rejects(new SelfWork(join(repo, "none.json"), {} as SelfWorkDeps).resume(), /no run/);
  const again = await sw.resume(1);
  assert.equal(again.status, "running");
  await sw.settled();
  assert.equal(sw.current?.status, "done");
  assert.ok(sent.some((m) => /^Resumed by you\./.test(m)));
  await assert.rejects(sw.resume(), /finished its goal/);
});

test("a commit the model makes inside its turn ends the turn, so the check runs before the next item", async () => {
  const root = await mkdtemp(join(tmpdir(), "selfwork-"));
  const repo = join(root, "repo");
  await mkdir(join(repo, ".git"), { recursive: true });
  let clock = 0;
  let turn = -1;
  let head = "aaa";
  const stopped: string[] = [];
  const sent: string[] = [];
  const checks: string[] = [];
  const sw = new SelfWork(join(root, "selfwork.json"), {
    createChat: async () => "c1",
    send: async (_id, text) => {
      sent.push(text);
      turn++;
    },
    state: async () => {
      // Turn 0 keeps running; after a while the model commits by itself.
      if (turn === 0 && clock > 60_000) head = "bbb";
      return turn === 0 ? { status: "running", last: "", events: Math.floor(clock / 2000) } : { status: "idle", last: "ALL DONE", events: 99 };
    },
    stopTurn: (id) => void stopped.push(id),
    git: async (_r, args) => ({ code: 0, out: args[0] === "rev-parse" && args[1] === "HEAD" ? `${head}\n` : args[0] === "log" ? "feat: insertStep\n" : args[0] === "rev-parse" ? "abc\n" : "" }),
    check: async (_r, cmd) => {
      checks.push(cmd);
      return { code: 0, out: "" };
    },
    notify: async () => undefined,
    sleep: async () => void (clock += 2000),
    now: () => clock,
  });
  await sw.start({ repo, goal: "x", check: "pnpm test", hours: 2 });
  await sw.settled();
  assert.deepEqual(stopped, ["c1"], "the turn was ended at the commit");
  assert.ok(checks.includes("pnpm test"), "the check ran");
  assert.equal(sw.current?.items[0]?.text, "feat: insertStep");
  assert.ok(sent.some((m) => /mark it done now/.test(m)));
});

test("never runs on an outside agent (Antigravity: Google's terms allow only chats the user drives)", async () => {
  const { sw, repo } = await setup(["ALL DONE"]);
  await assert.rejects(sw.start({ repo, goal: "x", check: "", hours: 1, modelId: "agent/antigravity" }), /cannot run on Antigravity/);
  await assert.rejects(sw.start({ repo, goal: "x", check: "", hours: 1, modelId: "main/agent/antigravity" }), /cannot run on Antigravity/);
});

test("each changed item reviews its own diff once before the commit, and keeps its name", async () => {
  const { sw, repo, git, sent } = await setup(["ITEM DONE: t26: access log keeps the key kind", "fixed the indentation\nITEM DONE", "ALL DONE"], { changed: true });
  await sw.start({ repo, goal: "board tasks", check: "pnpm test", hours: 1 });
  await sw.settled();
  assert.equal(sent.filter((m) => m === REVIEW).length, 2, "once for the item, once for the last change");
  const commits = git.filter((a) => a[0] === "commit");
  assert.equal(commits[0]![2], "self-work: t26: access log keeps the key kind");
  assert.equal(sw.current?.status, "done");
});

test("an item finished without its closing line is named from the plan line it ticked", () => {
  assert.equal(tickedItem("- [x] t26: done before\n- [x] t27: Hebrew errors\n- [ ] t28", ["t26: done before"]), "t27: Hebrew errors");
  assert.equal(tickedItem("- [ ] new item"), undefined);
});

test("a BLOCKED that only says nothing is left is the goal met; a bare BLOCKED takes its reason from above", () => {
  assert.equal(readOutcome("Blocked: t35 is done but there is no next item for self-work — no open {small}.").kind, "all");
  assert.equal(readOutcome("BLOCKED: the check needs a decision on the database").kind, "blocked");
  assert.equal(readOutcome("BLOCKED: there is no next item for self-work, no open {small} task left").kind, "all");
  assert.equal(readOutcome("BLOCKED: ** אין item פנוי ל־self-work. כדי להמשיך: merge").kind, "all");
  const bare = readOutcome("The check needs a password for the database.\n\nBLOCKED");
  assert.deepEqual(bare, { kind: "blocked", text: "The check needs a password for the database." });
  assert.equal(readOutcome("BLOCKED: **needs** a decision").text, "needs a decision");
});

test("a plan-only change is not committed: .kesher-self/plan.md is gitignored, so nothing is staged and git commit fails", async () => {
  // The real sequence the run uses (commitItem): git add -A, git commit, and only on success git rev-parse.
  // A plan-only change leaves the worktree clean (the plan file is ignored), so `git add -A` stages nothing and
  // `git commit` exits non-zero; the short hash is never read and no commit is made.
  const calls: string[][] = [];
  const planOnlyGit = async (repo: string, args: string[]): Promise<{ code: number; out: string }> => {
    calls.push([repo, ...args]);
    if (args[0] === "add") return { code: 0, out: "" };
    if (args[0] === "commit") return { code: 1, out: "nothing to commit" }; // clean tree
    if (args[0] === "rev-parse") return { code: 0, out: "abc1234\n" };
    throw new Error(`unexpected git ${args[0]}`);
  };
  const sha = await commitItem(planOnlyGit, "/repo", { subject: "self-work: tick a plan line", body: "Goal: plan" });
  assert.equal(sha, undefined, "no commit hash: nothing was committed");
  assert.deepEqual(
    calls.map((c) => c.slice(1)[0]),
    ["add", "commit"],
    "only add and commit ran; rev-parse was never reached",
  );
});

test("a real change is committed and its short hash returned", async () => {
  const head = "abc1234\n";
  const git = async (_repo: string, args: string[]): Promise<{ code: number; out: string }> => {
    if (args[0] === "add") return { code: 0, out: "" };
    if (args[0] === "commit") return { code: 0, out: "1 file changed" };
    if (args[0] === "rev-parse") return { code: 0, out: head };
    throw new Error(`unexpected git ${args[0]}`);
  };
  assert.equal(await commitItem(git, "/repo", { subject: "self-work: the change", body: "Goal: go" }), "abc1234");
});

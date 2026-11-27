import { test } from "node:test";
import assert from "node:assert/strict";
import { FAILOVER_DEFAULTS, type ExecutorRoom, type FailoverTask } from "./quota-failover.js";
import { buildHandoffNote, handoffChainText, handoffPromptHead, handoffWorth, HANDOFF_MAX_LINES, leftoverSize, pickHandoff, stopsInRow, type HandoffStep } from "./task-handoff.js";

const task = (o: Partial<FailoverTask> = {}): FailoverTask => ({ kind: "code", size: "M", risk: "low", status: "partial", executor: "auto", runBy: "ghostcli", relayOk: true, trainOk: false, sensitive: false, ...o });
const open: ExecutorRoom = { open: true };
const rooms = (o: Partial<Record<string, ExecutorRoom>> = {}) => ({
  antigravity: { open: true, needsTap: true },
  ghostcli: { open: true, relay: true },
  opencode: open,
  gemini: { open: true, training: true },
  local: open,
  claude: open,
  opus: open,
  ...o,
});
const step = (by: HandoffStep["by"], status: HandoffStep["status"] = "partial", files = 2): HandoffStep => ({ by, status, files, at: 1 });

test("worth handing on: partial or failed with a pushed diff or a useful report; never a blocked run or a done one", () => {
  assert.equal(handoffWorth({ status: "partial", files: 3, pushed: true }), true);
  assert.equal(handoffWorth({ status: "failed", files: 2, pushed: true }), true);
  assert.equal(handoffWorth({ status: "failed", files: 0, summary: "Found the cause in the runner: the retry loop never clears the flag; the fix is left." }), true);
  assert.equal(handoffWorth({ status: "failed", files: 0, summary: "error" }), false);
  assert.equal(handoffWorth({ status: "failed", files: 4, pushed: false }), false);
  assert.equal(handoffWorth({ status: "partial", files: 3, pushed: true, blocked: true }), false);
  assert.equal(handoffWorth({ status: "done", files: 3, pushed: true }), false);
});

test("the note says what was done, what is left, what went wrong and where to continue", () => {
  const note = buildHandoffNote({
    by: "ghostcli",
    model: "GhostCLI · glm",
    status: "partial",
    files: [{ path: "a.ts", added: 10, removed: 2 }, { path: "b.ts", added: 40, removed: 0 }],
    branch: "gcli/t-1-partial",
    summary: "Changed a.ts and b.ts.\nLeft: the tests for b.ts.\n- the Hebrew text",
    acceptance: "Tests pass\nHebrew and English",
    failNote: "The watchdog stopped it: no progress.",
    watch: ["read the same file 4 times"],
  });
  assert.match(note, /Handed on from GhostCLI \(GhostCLI · glm\): it ended partial/);
  assert.match(note, /Done so far \(2 files, on gcli\/t-1-partial\):\n- b\.ts \+40 -0\n- a\.ts \+10 -2/);
  assert.match(note, /Left:\n- Left: the tests for b\.ts\.\n- the Hebrew text/);
  assert.match(note, /Acceptance to meet:\n- Tests pass/);
  assert.match(note, /What went wrong:\n- The watchdog stopped it: no progress\.\n- watchdog: read the same file 4 times/);
  assert.match(note, /Continue from the branch gcli\/t-1-partial\./);
});

test("the note is capped and scrubbed by the leak guard", () => {
  const files = Array.from({ length: 30 }, (_, i) => ({ path: `f${i}.ts`, added: i, removed: 0 }));
  const summary = Array.from({ length: 50 }, (_, i) => `still to do ${i}: see /home/someone/secret and mail someone.dev@mailbox-test.net key ghp_${"a1B2c3D4e5".repeat(4)}`).join("\n");
  const note = buildHandoffNote({ by: "ghostcli", status: "partial", files, branch: "gcli/x-partial", summary, acceptance: Array.from({ length: 20 }, (_, i) => `acc ${i}`).join("\n"), failNote: "x" }, { username: "someone", home: "/home/someone" });
  assert.ok(note.split("\n").length <= HANDOFF_MAX_LINES);
  assert.match(note, /… and 20 more/);
  assert.doesNotMatch(note, /someone\.dev@mailbox-test\.net/);
  assert.doesNotMatch(note, /ghp_a1B2/);
  assert.doesNotMatch(note, /\/home\/someone/);
});

test("the leftover is one size smaller once some files are done", () => {
  assert.equal(leftoverSize("L", 3), "M");
  assert.equal(leftoverSize("M", 1), "S");
  assert.equal(leftoverSize("M", 0), "M");
});

test("a small leftover goes to OpenCode Go or the local model (in the user's order); a bigger one to Antigravity / GhostCLI", () => {
  assert.equal(pickHandoff(task({ size: "S" }), rooms(), FAILOVER_DEFAULTS, [step("ghostcli")])?.to, "opencode");
  assert.equal(pickHandoff(task({ size: "S" }), rooms({ opencode: { open: false } }), FAILOVER_DEFAULTS, [step("ghostcli")])?.to, "local");
  assert.equal(pickHandoff(task({ size: "S" }), rooms(), { ...FAILOVER_DEFAULTS, code: ["local", "ghostcli", "opencode", "antigravity"] }, [step("ghostcli")])?.to, "local");
  assert.equal(pickHandoff(task({ size: "M" }), rooms(), FAILOVER_DEFAULTS, [step("ghostcli")])?.to, "antigravity");
  assert.equal(pickHandoff(task({ size: "M", runBy: "antigravity" }), rooms(), FAILOVER_DEFAULTS, [step("antigravity")])?.to, "ghostcli");
});

test("the same executor is not picked after it stopped twice in a row; once, only when nobody else may", () => {
  const onlyGhost = rooms({ antigravity: { open: false, needsTap: true }, opencode: { open: false }, local: { open: false } });
  assert.equal(stopsInRow([step("ghostcli"), step("opencode"), step("ghostcli"), step("ghostcli")], "ghostcli"), 2);
  assert.equal(pickHandoff(task(), onlyGhost, FAILOVER_DEFAULTS, [step("ghostcli")])?.to, "ghostcli");
  assert.equal(pickHandoff(task(), onlyGhost, FAILOVER_DEFAULTS, [step("ghostcli"), step("ghostcli")]), undefined);
});

test("safety: an unsafe task never goes to a relay; a security task to Antigravity, else Claude's Opus agent; at most 4 handoffs", () => {
  assert.equal(pickHandoff(task({ runBy: "opencode", relayOk: false, size: "M" }), rooms({ antigravity: { open: false, needsTap: true } }), FAILOVER_DEFAULTS, [step("opencode")])?.to, "opencode");
  assert.equal(pickHandoff(task({ sensitive: true, risk: "high" }), rooms(), FAILOVER_DEFAULTS, [step("ghostcli")])?.to, "antigravity");
  assert.deepEqual(pickHandoff(task({ sensitive: true, risk: "high" }), rooms({ antigravity: { open: false, needsTap: true } }), FAILOVER_DEFAULTS, [step("ghostcli")]), { to: "opus", why: "security-sensitive" });
  assert.equal(pickHandoff(task({ size: "S" }), rooms(), FAILOVER_DEFAULTS, [step("ghostcli"), step("opencode"), step("antigravity"), step("local"), step("ghostcli")]), undefined);
});

test("the continuation's prompt starts with the note and the branch", () => {
  const head = handoffPromptHead({ note: "Done so far: a.ts\nLeft: tests", branch: "gcli/t-1-partial" });
  assert.match(head, /^Continue this task\./);
  assert.match(head, /from gcli\/t-1-partial/);
  assert.match(head, /Do not redo the done parts/);
  assert.match(head, /<handoff>\nDone so far: a\.ts\nLeft: tests\n<\/handoff>/);
});

test("the chain text, in English and Hebrew, with the run going on now", () => {
  const chain: HandoffStep[] = [step("ghostcli", "partial", 3), { by: "opencode", free: true, status: "done", files: 2, at: 2 }];
  assert.equal(handoffChainText(chain, false), "GhostCLI (partial: 3 files) → OpenCode Go free (finished)");
  assert.equal(handoffChainText(chain, true), "GhostCLI (חלקי: 3 קבצים) ← OpenCode Go חינמי (הסתיים)");
  assert.equal(handoffChainText([step("ghostcli", "failed", 1)], false, { by: "antigravity", status: "waiting" }), "GhostCLI (failed: 1 file) → Antigravity (waiting)");
  assert.equal(handoffChainText([step("ghostcli")], false), "");
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { AcpAgent } from "./acp.js";
import { fakeAgent } from "./acp-fake.test.js";
import { ChatHelpers, type ChatHelpersHost } from "./chat-helpers.js";

/** Chat helpers with a stub chat: a code chat on a git project whose copies are fake. */
function helpers(made: string[]) {
  const host = {
    deps: { config: { helpers: { minutes: 10 } } },
    session: () => undefined,
    workspace: () => "/work/my-project",
    worktree: () => ({ make: async (name: string) => (made.push(name), { path: "/p", finish: async () => "diff --git a/a.ts b/a.ts" }) }),
    leadModel: () => undefined,
  } as unknown as ChatHelpersHost;
  return new ChatHelpers(host);
}

const start = (seen: { mode?: string }) => (h: Parameters<typeof AcpAgent.connect>[1]) => AcpAgent.connect(fakeAgent(seen), h);

test("@antigravity: nothing is sent without the ask; Not now and an expired ask send nothing", async () => {
  const made: string[] = [];
  const h = helpers(made);
  const r1 = h.startExternal("c1", "change a to b", start({}));
  assert.equal((await h.runs.wait([r1.id]))[0]?.state, "failed", "no ask wired: it does not run");
  let answer!: (a: "allow" | "deny" | "timeout") => void;
  const asked: string[] = [];
  h.askAntigravity = (info) => {
    asked.push(info.where);
    return { ask: { requestId: `q${asked.length}`, until: Date.now() + 60_000, left: 7 }, answer: new Promise((r) => (answer = r)), cancel: () => answer("deny") };
  };
  const r2 = h.startExternal("c1", "change a to b", start({}));
  await new Promise((r) => setImmediate(r));
  const card = h.runs.get(r2.id)!;
  assert.equal(card.state, "asking");
  assert.deepEqual([card.runAsk?.requestId, card.runAsk?.left, card.runAsk?.text], ["q1", 7, "change a to b"]);
  assert.deepEqual(asked, ["my-project"], "the project's name, never its path");
  answer("deny");
  const end2 = (await h.runs.wait([r2.id]))[0]!;
  assert.equal(end2.state, "failed");
  assert.match(end2.error ?? "", /Not now/);
  assert.equal(end2.runAsk, undefined, "the ask leaves the card");
  assert.deepEqual(made, [], "no copy made, nothing sent");
  const r3 = h.startExternal("c1", "x", start({}));
  await new Promise((r) => setImmediate(r));
  answer("timeout");
  assert.match((await h.runs.wait([r3.id]))[0]?.error ?? "", /expired/);
});

test("@antigravity: Run sends the one message; each new message asks again", async () => {
  const made: string[] = [];
  const h = helpers(made);
  const answers: Array<(a: "allow" | "deny" | "timeout") => void> = [];
  h.askAntigravity = () => {
    let a!: (x: "allow" | "deny" | "timeout") => void;
    const p = new Promise<"allow" | "deny" | "timeout">((r) => (a = r));
    answers.push(a);
    return { ask: { requestId: `q${answers.length}`, until: Date.now() + 60_000, left: 3 }, answer: p, cancel: () => a("deny") };
  };
  const r = h.startExternal("c1", "change a to b", start({}));
  await new Promise((res) => setImmediate(res));
  answers[0]!("allow");
  const end = (await h.runs.wait([r.id]))[0]!;
  assert.equal(end.state, "done", end.error);
  assert.equal(made.length, 1);
  assert.match(end.diff ?? "", /a\.ts/);
  h.startExternal("c1", "and c to d", start({}));
  await new Promise((res) => setImmediate(res));
  assert.equal(answers.length, 2, "a second message is a second ask, never the first yes");
  answers[1]!("deny");
});

test("@antigravity: Stop while it waits cancels the ask", async () => {
  const h = helpers([]);
  let cancelled = false;
  h.askAntigravity = () => ({ ask: { requestId: "q", until: Date.now() + 60_000, left: 1 }, answer: new Promise(() => undefined), cancel: () => void (cancelled = true) });
  const r = h.startExternal("c1", "x", start({}));
  await new Promise((res) => setImmediate(res));
  h.runs.stop(r.id);
  assert.equal((await h.runs.wait([r.id]))[0]?.state, "stopped");
  assert.equal(cancelled, true);
});

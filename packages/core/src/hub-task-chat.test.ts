import { test } from "node:test";
import assert from "node:assert/strict";
import type { InboxTaskView } from "@kesher/shared";
import { TaskChatDesk, type TaskChatDeps } from "./hub-task-chat.js";

const task = (id: string, title: string, status: string, runBy = "local", extra: object = {}) => ({ id, title, status, runBy, executor: runBy, ...extra }) as unknown as InboxTaskView;

/** A desk with a fake pool: `says` is what the small model answers, `did` records the inbox actions. */
function setup(says: string | Error, over: Partial<TaskChatDeps> = {}) {
  const did: string[] = [];
  const prompts: string[] = [];
  let now = 1_000_000;
  const deps: TaskChatDeps = {
    inboxTasks: async () => [task("r-1", "Fix the hub page", "waiting", "antigravity"), task("r-2", "Port plugin", "running"), task("r-3", "Fix hub page again", "waiting", "local", { queued: 1 })],
    complete: async (m) => {
      prompts.push(m.map((x) => x.content).join("\n"));
      if (says instanceof Error) throw says;
      return says;
    },
    addTask: async (t) => {
      did.push(`add:${t.title}:${t.executor}`);
      return task("n", t.title, "waiting");
    },
    assign: async (id, to, confirm) => {
      did.push(`assign:${id}:${to}:${confirm}`);
      return { ok: true, text: "ok" };
    },
    inboxCommand: async (a, id) => {
      did.push(`${a}:${id}`);
      return { ok: true, text: "ok" };
    },
    ...over,
  };
  const desk = new TaskChatDesk(deps, () => now);
  const ask = (op: "say" | "apply" | "cancel", extra: object = {}) => desk.handle({ chatId: "c1", op, at: now, ...extra });
  return { desk, ask, did, prompts, tick: (ms: number) => (now += ms) };
}

const REPLY = JSON.stringify({ reply: "Split and closed", actions: [{ op: "split", id: 1, parts: ["Part A", "Part B"], executor: "local" }, { op: "skip", id: 3 }, { op: "skip", id: 2 }] });

test("say: the model sees the board, the answer is a proposal and nothing changes yet", async () => {
  const s = setup(REPLY);
  const a = await s.ask("say", { text: "split task 1" });
  assert.equal(a.kind, "reply");
  assert.deepEqual(a.proposal!.actions.map((x) => x.op), ["split", "skip"], "the running task cannot be skipped");
  assert.match(s.prompts[0]!, /1 \| Fix the hub page \| antigravity \| waiting/);
  assert.match(s.prompts[0]!, /3 \| Fix hub page again \| local \| queued/);
  assert.deepEqual(s.did, []);
});

test("apply: runs the kept proposal once (split = add parts then skip), a second apply finds nothing", async () => {
  const s = setup(REPLY);
  const p = (await s.ask("say", { text: "x" })).proposal!;
  const r = await s.ask("apply", { proposalId: p.id });
  assert.deepEqual([r.kind, r.done, r.failed], ["applied", 2, 0]);
  assert.deepEqual(s.did, ["add:Part A:local", "add:Part B:local", "inbox-cancel:r-1", "inbox-cancel:r-3"]);
  const again = await s.ask("apply", { proposalId: p.id });
  assert.equal(again.kind, "refused");
  assert.equal(s.did.length, 4);
  assert.equal((await s.ask("apply", { proposalId: "forged" })).kind, "refused", "only the PC's own proposals apply");
});

test("cancel drops the proposal; assign never confirms for the owner; a task that started is not touched", async () => {
  const s = setup(JSON.stringify({ reply: "ok", actions: [{ op: "assign", id: 1, to: "gemini" }, { op: "queue", id: 1 }] }));
  const p = (await s.ask("say", { text: "x" })).proposal!;
  assert.equal((await s.ask("cancel", { proposalId: p.id })).kind, "cancelled");
  assert.equal((await s.ask("apply", { proposalId: p.id })).kind, "refused");
  const q = (await s.ask("say", { text: "y" })).proposal!;
  const r = await s.ask("apply", { proposalId: q.id });
  assert.equal(r.done, 2);
  assert.deepEqual(s.did, ["assign:r-1:gemini:false", "inbox-queue:r-1"]);
  const gone = setup(JSON.stringify({ reply: "ok", actions: [{ op: "skip", id: 1 }] }), { inboxTasks: undefined });
  assert.equal((await gone.ask("say", { text: "x" })).kind, "refused");
});

test("refusals: unreadable model text, no pool, a model error, an old ask, rate limit, busy", async () => {
  assert.deepEqual([(await setup("sorry I cannot").ask("say", { text: "x" })).proposal, (await setup("sorry").ask("say", { text: "x" })).kind], [undefined, "reply"]);
  assert.equal((await setup("{}", { complete: undefined }).ask("say", { text: "x" })).kind, "refused");
  assert.equal((await setup(new Error("boom")).ask("say", { text: "x" })).kind, "refused");
  const s = setup(REPLY);
  assert.equal((await s.desk.handle({ chatId: "c1", op: "say", text: "x", at: 1 })).kind, "refused", "stale");
  for (let i = 0; i < 12; i++) await s.ask("cancel", { proposalId: "p" });
  assert.match((await s.ask("say", { text: "x" })).text, /Too many/);
  let release!: () => void;
  const slow = setup("{}", { complete: () => new Promise<string>((res) => (release = () => res('{"reply":"hi"}'))) });
  const first = slow.ask("say", { text: "a" });
  await new Promise((r) => setImmediate(r));
  assert.match((await slow.ask("say", { text: "b" })).text, /still answering/);
  release();
  assert.equal((await first).text, "hi");
});

test("a proposal expires after 30 minutes", async () => {
  const s = setup(REPLY);
  const p = (await s.ask("say", { text: "x" })).proposal!;
  s.tick(31 * 60_000);
  assert.equal((await s.ask("apply", { proposalId: p.id })).kind, "refused");
});

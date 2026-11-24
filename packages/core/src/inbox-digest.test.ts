import { test } from "node:test";
import assert from "node:assert/strict";
import type { InboxTaskView } from "@kesher/shared";
import { buildDigest, digestSince, reviewerVerdict, type DigestInput } from "./inbox-digest.js";

const NOW = new Date(2026, 10, 24, 21, 15).getTime();
const SINCE = NOW - 12 * 3_600_000;

const task = (o: Partial<InboxTaskView> & Pick<InboxTaskView, "id" | "status" | "runBy">): InboxTaskView => ({ title: `Task ${o.id}`, goal: "g", branch: `agy/${o.id}`, ...o }) as InboxTaskView;

const state = (tasks: InboxTaskView[]): DigestInput["state"] => ({
  settings: { enabled: true, paused: false, dailyCap: 10 } as DigestInput["state"]["settings"],
  today: { date: "2026-11-24", used: 4 },
  tasks,
  busy: { free: true, reasons: [] },
  loop: { state: "running" },
});

test("the digest groups what ended since the last digest per executor, with branches and reasons", () => {
  const md = buildDigest({
    now: NOW,
    since: SINCE,
    state: state([
      task({ id: "a1", status: "done", runBy: "antigravity", endedAt: NOW - 3_600_000, pushed: true, summary: "Did it.\nVerdict: approve" }),
      task({ id: "a2", status: "failed", runBy: "antigravity", endedAt: NOW - 7_200_000, note: "The check failed:\n  tests" }),
      task({ id: "a3", status: "done", runBy: "antigravity", endedAt: SINCE - 1000 }),
      task({ id: "l1", status: "partial", runBy: "local", endedAt: NOW - 600_000 }),
      task({ id: "l2", status: "waiting", runBy: "local" }),
    ]),
  });
  assert.match(md, /^<!-- digest-at: \d+ -->/);
  assert.match(md, /## antigravity[\s\S]*\*\*Finished \(1\)\*\*\n- a1: Task a1 \(branch agy\/a1 pushed; reviewer: approve\)/);
  assert.match(md, /\*\*Failed \(1\)\*\*\n- a2: Task a2 \(why: The check failed: tests\)/);
  assert.ok(!md.includes("a3:"), "ended before the window");
  assert.match(md, /## local[\s\S]*\*\*Partial \(1\)\*\*[\s\S]*\*\*Waiting or running \(1\)\*\*\n- l2:/);
  assert.match(md, /## Branches pushed, not merged\n\n- agy\/a1 \(a1, done\)/);
  assert.match(md, /Antigravity today: 4 of 10 runs/);
  assert.match(md, /This computer: free/);
});

test("quotas, caps, a paused loop and a busy computer are stated; an empty inbox says so", () => {
  const md = buildDigest({
    now: NOW,
    since: SINCE,
    state: { ...state([]), quota: { until: NOW + 3_600_000, estimated: true }, loop: { state: "paused", until: NOW + 3_600_000, why: "quota" }, busy: { free: false, reasons: ["a game is running"] }, free: [{ id: "x", name: "OpenRouter", used: 12, limit: 50, trainsOnData: true }] },
    selfWork: { status: "running", branch: "self/night" },
  });
  assert.match(md, /No tasks in the inbox\./);
  assert.match(md, /plan quota out until 2026-11-24 22:15 \(estimated\)/);
  assert.match(md, /OpenRouter: 12 of 50 requests today/);
  assert.match(md, /Work loop: paused until 22:15 \(quota\)/);
  assert.match(md, /busy \(a game is running\)/);
  assert.match(md, /Self-work: running on self\/night/);
  assert.ok(!/[A-Za-z]:\\|\/home\//.test(md), "no paths");
});

test("the reviewer's verdict is read only from a stated line", () => {
  assert.equal(reviewerVerdict({ summary: "ok\nReviewer: needs changes in x.ts" }), "needs changes in x.ts");
  assert.equal(reviewerVerdict({ note: "Verdict - approve" }), "approve");
  assert.equal(reviewerVerdict({ summary: "We discuss the reviewer verdict later" }), undefined);
});

test("since comes from the previous digest's first line, else a day back", () => {
  assert.equal(digestSince(`<!-- digest-at: ${SINCE} -->\n# x`, NOW), SINCE);
  assert.equal(digestSince("", NOW), NOW - 24 * 3_600_000);
  assert.equal(digestSince(`<!-- digest-at: ${NOW + 5} -->`, NOW), NOW - 24 * 3_600_000, "a time in the future is not trusted");
});

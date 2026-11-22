import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { AgentMessage } from "@kesher/shared";
import { PRUNED_MARK, capTools, isTurnStart, openToolOutput, pinnedBefore, pinnedOutputs, pruneToolOutputs, statusSummary, summaryLine, supersededReads } from "./budget.js";

const long = (tag: string) => `${tag} first line\n${"x".repeat(2000)}`;
/** A turn: the user's message, one tool call and its result, an answer. */
const turn = (n: number): AgentMessage[] => [
  { role: "user", content: `question ${n}` },
  { role: "assistant", content: "", toolCalls: [{ id: `c${n}`, name: "read_file", arguments: {} }] },
  { role: "tool", toolCallId: `c${n}`, toolName: "read_file", content: long(`out${n}`) },
  { role: "assistant", content: `answer ${n}` },
];

describe("pruneToolOutputs", () => {
  test("results of the last two turns stay; older ones become a summary line with their id", () => {
    const msgs = [...turn(1), ...turn(2), ...turn(3)];
    const r = pruneToolOutputs(msgs);
    assert.equal(r.messages.length, msgs.length);
    assert.deepEqual(r.ids, ["c1"]);
    assert.ok(r.messages[2]!.content.startsWith(`${PRUNED_MARK} c1] read_file: out1 first line`));
    assert.match(r.messages[2]!.content, /tool_output id "c1"/);
    assert.equal(r.messages[6]!.content, msgs[6]!.content);
    assert.ok(r.prunedChars > 1500);
    assert.equal(msgs[2]!.content, long("out1"), "the stored conversation is not changed");
  });

  test("pinned results and the latest result are never pruned", () => {
    const msgs = [...turn(1), ...turn(2), ...turn(3)];
    assert.deepEqual(pruneToolOutputs(msgs, { pinned: new Set(["c1"]) }).ids, []);
    // One long turn after two old ones with no newer tool result: the latest result stays even though it is old.
    const old: AgentMessage[] = [...turn(1), { role: "user", content: "hi" }, { role: "assistant", content: "hello" }, { role: "user", content: "thanks" }];
    assert.deepEqual(pruneToolOutputs(old).ids, []);
  });

  test("KesherAI's own notes inside a run do not count as turns", () => {
    const msgs: AgentMessage[] = [...turn(1), { role: "user", content: "[KesherAI] This is your last step" }, { role: "user", content: "(A plan from your teammate x)" }, ...turn(2)];
    assert.deepEqual(pruneToolOutputs(msgs).ids, []);
    assert.equal(isTurnStart({ role: "user", content: "[KesherAI] note" }), false);
    assert.equal(isTurnStart({ role: "user", content: "תצייר חתול" }), true);
  });

  test("short outputs stay; pictures are dropped and counted", () => {
    const pic: AgentMessage = { role: "tool", toolCallId: "p", toolName: "view_image", content: "ok", images: ["data"] };
    const msgs: AgentMessage[] = [{ role: "user", content: "a" }, { role: "tool", toolCallId: "s", toolName: "x", content: "short" }, pic, ...turn(2), ...turn(3)];
    const r = pruneToolOutputs(msgs);
    assert.deepEqual(r.ids, ["p"]);
    assert.equal(r.messages[2]!.images, undefined);
    assert.ok(r.prunedChars >= 5000);
  });

  test("the line moves only when a turn starts (the prompt's start stays for the engine's cache)", () => {
    const msgs = [...turn(1), ...turn(2), ...turn(3)];
    const a = pruneToolOutputs(msgs).messages;
    const more: AgentMessage[] = [...msgs, { role: "assistant", content: "", toolCalls: [{ id: "c9", name: "read_file", arguments: {} }] }, { role: "tool", toolCallId: "c9", toolName: "read_file", content: long("out9") }];
    const b = pruneToolOutputs(more).messages;
    assert.deepEqual(b.slice(0, a.length), a);
  });

  /** A read_file call and its numbered result. */
  const read = (id: string, args: Record<string, unknown>, body = `    1  ${"y".repeat(800)}`): AgentMessage[] => [
    { role: "assistant", content: "", toolCalls: [{ id, name: "read_file", arguments: args }] },
    { role: "tool", toolCallId: id, toolName: "read_file", content: body },
  ];

  test("an older read of the same file becomes a superseded line, even inside the kept turns", () => {
    const msgs: AgentMessage[] = [{ role: "user", content: "go" }, ...read("r1", { path: "src/a.ts" }), ...read("r2", { path: "./src/a.ts" }), { role: "assistant", content: "done" }];
    const r = pruneToolOutputs(msgs);
    assert.deepEqual(r.ids, ["r1"]);
    assert.equal(r.superseded, 1);
    assert.equal(r.messages[2]!.content, '[read_file src/a.ts superseded by a later read] (id "r1")');
    assert.equal(r.messages[4]!.content, msgs[4]!.content);
    assert.ok(r.prunedChars > 700);
  });

  test("partial reads only supersede the same range; a cut-off plain read covers no other range", () => {
    const tail = `    1  a\n… 900 more lines: read on with offset 2`;
    const msgs: AgentMessage[] = [
      { role: "user", content: "go" },
      ...read("p1", { path: "b.ts", offset: 100, limit: 50 }),
      ...read("p2", { path: "b.ts", offset: 300, limit: 50 }),
      ...read("p3", { path: "b.ts" }, tail),
      ...read("p4", { path: "b.ts", offset: 300, limit: 50 }),
      ...read("e1", { path: "c.ts" }),
      ...read("e2", { path: "c.ts" }, "Error: c.ts does not exist."),
    ];
    assert.deepEqual([...supersededReads(msgs).keys()], ["p2"]);
  });

  test("command and check summaries keep the last line (exit code, pass/fail)", () => {
    assert.equal(statusSummary("> npm test\nlots\nof\noutput\n\nexit code 1"), "> npm test … exit code 1");
    assert.equal(statusSummary("only line"), "only line");
    const out = `> pnpm test\n${"z".repeat(900)}\n# fail 2`;
    const msgs: AgentMessage[] = [
      { role: "user", content: "1" }, { role: "assistant", content: "", toolCalls: [{ id: "k", name: "run_command", arguments: {} }] }, { role: "tool", toolCallId: "k", toolName: "run_command", content: out },
      ...turn(2), ...turn(3),
    ];
    assert.match(pruneToolOutputs(msgs).messages[2]!.content, /run_command: > pnpm test … # fail 2/);
  });
});

test("openToolOutput returns the stored output in parts", () => {
  const msgs = turn(1);
  assert.equal(openToolOutput(msgs, "c1"), long("out1"));
  const big: AgentMessage[] = [{ role: "tool", toolCallId: "b", content: "y".repeat(25_000) }];
  assert.match(openToolOutput(big, "b"), /the rest: tool_output id "b" from 20000/);
  assert.equal(openToolOutput(big, "b", 20_000).length, 5000);
  assert.throws(() => openToolOutput(msgs, "nope"), /No tool output/);
});

test("summaryLine and pinnedOutputs", () => {
  assert.equal(summaryLine("\n---\n  Found 3 files\nmore"), "Found 3 files");
  assert.equal(summaryLine("z".repeat(300)).length, 158);
  const pins = pinnedOutputs([{ type: "tool_pin", callId: "a", pinned: true }, { type: "tool_pin", callId: "b", pinned: true }, { type: "note" }, { type: "tool_pin", callId: "a", pinned: false }]);
  assert.deepEqual([...pins], ["b"]);
});

describe("capTools", () => {
  const tools = ["a", "b", "c", "x", "y", "z"].map((name) => ({ name }));
  test("under the cap: everything stays", () => {
    assert.deepEqual(capTools(tools, { core: ["a"], rank: new Map(), since: 0, cap: 10 }).over, []);
  });
  test("this message's tools first, then core, then older loads; prompt order kept", () => {
    const rank = new Map([["x", 1], ["y", 5], ["z", 6]]);
    const r = capTools(tools, { core: ["a", "b", "c"], rank, since: 4, cap: 4 });
    assert.deepEqual(r.keep.map((t) => t.name), ["a", "b", "y", "z"]);
    assert.deepEqual(r.over, ["c", "x"]);
  });
  test("the core set is never cut below its size", () => {
    const r = capTools(tools, { core: ["a", "b", "c", "x"], rank: new Map([["z", 2]]), since: 1, cap: 2 });
    assert.equal(r.keep.length, 4);
    assert.ok(r.keep.some((t) => t.name === "z"), "the newest load still ranks first");
  });
});

describe("pinnedBefore", () => {
  const msgs: AgentMessage[] = [
    { role: "user", content: "read both" },
    { role: "tool", toolCallId: "a", toolName: "read_file", content: "AAA" },
    { role: "tool", toolCallId: "b", toolName: "read_file", content: "BBB" },
  ];
  test("keeps the pinned results of the summarised part, in order", () => {
    const out = pinnedBefore(msgs, new Set(["a", "b"]));
    assert.match(out, /\[read_file a\]\nAAA[\s\S]*\[read_file b\]\nBBB/);
  });
  test("nothing pinned there: empty", () => {
    assert.equal(pinnedBefore(msgs, new Set(["z"])), "");
  });
  test("over the limit the newest pin is kept first", () => {
    const out = pinnedBefore(msgs, new Set(["a", "b"]), 16);
    assert.match(out, /BBB/);
    assert.doesNotMatch(out, /AAA/);
  });
});

import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentEvent } from "@kesher/shared";
import {
  answerHas,
  answerLanguage,
  answerMaxLines,
  asksBeforeActing,
  filesExist,
  firstTool,
  judge,
  noRecap,
  noRepeatedCalls,
  noTool,
  noTools,
  noWholeRead,
  saysBeforeTools,
  sendsFile,
  stopsAtSignIn,
  todoKeptAndDone,
  toolBeforeAnswer,
  usesTool,
  type CheckedTurn,
} from "./checks.js";
import { SCENARIOS, pickScenarios } from "./scenarios.js";

type NewEvent = AgentEvent extends infer E ? (E extends AgentEvent ? Omit<E, "seq" | "at"> : never) : never;

/** A recorded fake turn: the events get seq 1.. in order. */
function turn(evs: NewEvent[], files?: string[]): CheckedTurn {
  return { events: evs.map((e, i) => ({ ...e, seq: i + 1, at: "2026-11-28T10:00:00Z" }) as AgentEvent), ...(files ? { files } : {}) };
}
const user = (text: string): NewEvent => ({ type: "user", text });
const say = (text: string): NewEvent => ({ type: "assistant", turn: 1, text });
let n = 0;
const call = (name: string, input: Record<string, unknown> = {}): NewEvent => ({ type: "tool_call", callId: `c${++n}`, name, input });
const result = (name: string, ok = true, extra: Record<string, unknown> = {}): NewEvent => ({ type: "tool_result", callId: `r${++n}`, name, ok, output: "", ...extra }) as NewEvent;
const todo = (...states: Array<"pending" | "in_progress" | "done">): NewEvent => ({ type: "todo", callId: `t${++n}`, items: states.map((state, i) => ({ id: String(i + 1), title: `step ${i + 1}`, state })) });

test("firstTool and noTool", () => {
  const good = turn([user("open"), call("browser_open", { url: "http://127.0.0.1:1/article" }), say("Ada Marlow")]);
  const bad = turn([user("open"), call("web_search", { query: "x" }), call("browser_open")]);
  assert.equal(firstTool(/^browser_(open|navigate)$/).test(good), undefined);
  assert.match(firstTool(/^browser_open$/).test(bad)!, /web_search/);
  assert.equal(noTool("web_search").test(good), undefined);
  assert.match(noTool("web_search").test(bad)!, /web_search was called/);
  assert.match(firstTool("browser_open").test(turn([user("x"), say("no")]))!, /no tool/);
});

test("noTools, answerHas, answerMaxLines", () => {
  const plain = turn([user("17*23?"), say("391")]);
  assert.equal(noTools.test(plain), undefined);
  assert.equal(answerHas("391").test(plain), undefined);
  assert.equal(answerHas(/\b391\b/).test(plain), undefined);
  assert.match(answerHas("392").test(plain)!, /lacks "392"/);
  assert.match(noTools.test(turn([user("x"), call("run_command"), say("391")]))!, /run_command/);
  assert.equal(answerMaxLines(3).test(plain), undefined);
  assert.match(answerMaxLines(2).test(turn([user("x"), say("a\nb\n\nc")]))!, /3 lines/);
  assert.match(answerHas("x").test(turn([user("x")]))!, /no final answer/);
});

test("answerLanguage follows the user", () => {
  assert.equal(answerLanguage("he").test(turn([user("מה?"), say("הבירה של צרפת היא פריז (Paris).")])), undefined);
  assert.match(answerLanguage("he").test(turn([user("מה?"), say("The capital of France is Paris.")]))!, /not in Hebrew/);
  assert.equal(answerLanguage("en").test(turn([user("what?"), say("Tokyo.")])), undefined);
  assert.match(answerLanguage("en").test(turn([user("what?"), say("טוקיו.")]))!, /not in English/);
});

test("usesTool with an input pattern (schedule_task daily 09:00)", () => {
  const good = turn([user("every morning"), call("schedule_task", { name: "water", prompt: "drink", when: "daily 09:00" }), say("Set.")]);
  const wrong = turn([user("every morning"), call("schedule_task", { when: "weekdays 09:00" })]);
  const check = usesTool("schedule_task", { key: "when", match: /^daily 0?9:00$/i });
  assert.equal(check.test(good), undefined);
  assert.match(check.test(wrong)!, /weekdays 09:00/);
  assert.match(check.test(turn([user("x"), say("ok")]))!, /never called/);
});

test("toolBeforeAnswer: search_chats before the answer", () => {
  const good = turn([user("logo?"), say("Let me look."), call("search_chats", { query: "logo" }), result("search_chats"), say("We picked teal.")]);
  const late = turn([user("logo?"), call("recent_chats"), say("Teal.")]);
  assert.equal(toolBeforeAnswer("search_chats", "recent_chats").test(good), undefined);
  assert.equal(toolBeforeAnswer("search_chats", "recent_chats").test(late), undefined);
  assert.match(toolBeforeAnswer("search_chats").test(turn([user("logo?"), say("Teal, I think.")]))!, /none of search_chats/);
});

test("saysBeforeTools", () => {
  assert.equal(saysBeforeTools.test(turn([user("read"), { type: "assistant_delta", turn: 1, text: "Reading it now." }, call("read_file", { path: "notes.txt" }), say("flour")])), undefined);
  assert.match(saysBeforeTools.test(turn([user("read"), call("read_file"), say("flour")]))!, /before any words/);
});

test("asksBeforeActing", () => {
  const asked: NewEvent = { type: "question", questionId: "q1", question: "Which language?" };
  assert.equal(asksBeforeActing.test(turn([user("rewrite all"), call("list_files"), asked])), undefined);
  assert.match(asksBeforeActing.test(turn([user("rewrite all"), call("write_file", { path: "a.js" }), asked]))!, /write_file ran before the question/);
  assert.match(asksBeforeActing.test(turn([user("rewrite all"), call("edit_file")]))!, /before any question/);
  // A sign-in card is not a question to the user about the task.
  assert.match(asksBeforeActing.test(turn([user("rewrite all"), { type: "question", questionId: "q", question: "Sign in", kind: "signin" }]))!, /never asked/);
});

test("todoKeptAndDone", () => {
  assert.equal(todoKeptAndDone.test(turn([user("4 steps"), todo("in_progress", "pending"), todo("done", "in_progress"), todo("done", "done"), say("Done.")])), undefined);
  assert.match(todoKeptAndDone.test(turn([user("4 steps"), say("Done.")]))!, /no task list/);
  assert.match(todoKeptAndDone.test(turn([user("4 steps"), todo("pending", "pending")]))!, /never updated/);
  assert.match(todoKeptAndDone.test(turn([user("4 steps"), todo("in_progress", "pending"), todo("done", "pending")]))!, /1 of 2/);
});

test("stopsAtSignIn", () => {
  const card: NewEvent = { type: "question", questionId: "s", question: "Sign in needed", kind: "signin", signIn: { wall: "login", site: "127.0.0.1:1", browser: "pane" } };
  assert.equal(stopsAtSignIn.test(turn([user("sign in"), call("browser_open"), result("browser_open"), card, say("Please sign in.")])), undefined);
  assert.match(stopsAtSignIn.test(turn([user("sign in"), call("browser_type", { ref: "e3", text: "x" }), result("browser_type", true), card]))!, /typed/);
  assert.match(stopsAtSignIn.test(turn([user("sign in"), call("browser_open"), say("Done")]))!, /no "Sign in needed"/);
});

test("sendsFile", () => {
  const card = { kind: "text", name: "summary.md", size: 10 };
  assert.equal(sendsFile.test(turn([user("summary"), call("write_file"), call("send_file"), result("send_file", true, { cards: [card] })])), undefined);
  assert.match(sendsFile.test(turn([user("summary"), call("send_file"), result("send_file", false)]))!, /no send_file/);
});

test("noRepeatedCalls", () => {
  assert.equal(noRepeatedCalls.test(turn([user("x"), call("list_files", { path: "." }), call("list_files", { path: "docs" })])), undefined);
  assert.match(noRepeatedCalls.test(turn([user("x"), call("list_files", { path: "." }), call("list_files", { path: "." })]))!, /twice/);
});

test("noWholeRead", () => {
  const c = noWholeRead("big.log");
  assert.equal(c.test(turn([user("err"), call("search", { pattern: "ERROR" }), call("read_file", { path: "big.log", offset: 41230, limit: 10 })])), undefined);
  assert.equal(c.test(turn([user("err"), call("run_command", { command: "cat big.log | grep ERROR" })])), undefined);
  assert.match(c.test(turn([user("err"), call("read_file", { path: "logs/big.log" })]))!, /read_file read all/);
  assert.match(c.test(turn([user("err"), call("run_command", { command: "cat big.log" })]))!, /printed all/);
  assert.match(c.test(turn([user("err"), call("run_command", { command: "Get-Content .\\big.log" })]))!, /printed all/);
});

test("noRecap", () => {
  assert.equal(noRecap.test(turn([user("x"), say("It printed `hello from kesher`.")])), undefined);
  assert.match(noRecap.test(turn([user("x"), say("## Summary\nIt worked.")]))!, /recap heading/);
  assert.match(noRecap.test(turn([user("x"), say("1. Created hello.js\n2. Ran it\n3. Read the output\nIt printed hello.")]))!, /3 list lines/);
});

test("filesExist and judge", () => {
  const t = turn([user("x"), say("ok")], ["a.txt", "b.txt"]);
  assert.equal(filesExist("a.txt", "B.txt").test(t), undefined);
  assert.match(filesExist("a.txt", "c.txt").test(t)!, /missing: c\.txt/);
  assert.equal(judge([noTools, answerHas("ok")], t), undefined);
  assert.deepEqual(judge([noTools, answerHas("nope")], t), { check: "answer-has", reason: "the answer lacks \"nope\"" });
});

test("scenarios: unique ids, both languages, checks, and pickScenarios", () => {
  const ids = SCENARIOS.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(SCENARIOS.length >= 12);
  for (const s of SCENARIOS) {
    assert.ok(s.he && s.en && s.checks.length, s.id);
    assert.ok(s.message({ url: (p) => `http://127.0.0.1:9${p}` }).length > 5, s.id);
  }
  assert.deepEqual(pickScenarios(["plain-math", "browser-open"]).map((s) => s.id), ["browser-open", "plain-math"]);
  assert.equal(pickScenarios().length, SCENARIOS.length);
  assert.throws(() => pickScenarios(["nope"]), /Unknown chat check: nope/);
});

test("schedule-daily runs in a normal chat (incognito chats have no schedule tools) and its message routes to schedule_task", async () => {
  const { SCENARIOS } = await import("./scenarios.js");
  const { ToolRouter, scheduleNote } = await import("../tool-router.js");
  const s = SCENARIOS.find((x) => x.id === "schedule-daily")!;
  assert.equal(s.normalChat, true);
  const r = await new ToolRouter().route(s.message({} as never), ["schedule_task", "set_timer", "write_file"], [], false);
  assert.ok(r.tools.includes("schedule_task"));
  assert.match(scheduleNote(r.recurring, r.tools)!, /call schedule_task now/);
});

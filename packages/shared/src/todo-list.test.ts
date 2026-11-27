import { test } from "node:test";
import assert from "node:assert/strict";
import { TODO_MAX_ITEMS, applyTodo, latestTodo, todoProgress, todoReply, todoState, type TodoItem } from "./todo-list.js";

const list = (r: ReturnType<typeof applyTodo>): TodoItem[] => {
  assert.ok("items" in r, "error" in r ? r.error : "");
  return r.items;
};

test("todoState reads the usual spellings and refuses others", () => {
  assert.equal(todoState("completed"), "done");
  assert.equal(todoState("In Progress"), "in_progress");
  assert.equal(todoState("in-progress"), "in_progress");
  assert.equal(todoState("todo"), "pending");
  assert.equal(todoState("maybe"), undefined);
  assert.equal(todoState(3), undefined);
});

test("items writes the whole list: ids by position, pending by default, content/status taken too", () => {
  const items = list(applyTodo([], { items: [{ title: "Read the code" }, { content: "  Write   tests ", status: "in_progress", activeForm: "Writing tests" }, "Check"] }));
  assert.deepEqual(items, [
    { id: "1", title: "Read the code", state: "pending" },
    { id: "2", title: "Write tests", state: "in_progress", activeForm: "Writing tests" },
    { id: "3", title: "Check", state: "pending" },
  ]);
});

test("items: a repeated id gets its position, the list is cut to the most steps, empty titles are refused", () => {
  const items = list(applyTodo([], { items: [{ id: "a", title: "x" }, { id: "a", title: "y" }] }));
  assert.deepEqual(items.map((i) => i.id), ["a", "a-2"]);
  const many = list(applyTodo([], { items: Array.from({ length: 30 }, (_, n) => ({ title: `s${n}` })) }));
  assert.equal(many.length, TODO_MAX_ITEMS);
  assert.match((applyTodo([], { items: [{ title: "ok" }, { title: "  " }] }) as { error: string }).error, /step 2 has no title/);
  assert.match((applyTodo([], { items: "nope" }) as { error: string }).error, /must be a list/);
});

test("set changes states by id without touching the old list; unknown ids and states are refused", () => {
  const prev = list(applyTodo([], { items: [{ title: "a" }, { title: "b" }] }));
  const next = list(applyTodo(prev, { set: [{ id: "1", state: "done" }, { id: "2", status: "in_progress" }] }));
  assert.deepEqual(next.map((i) => i.state), ["done", "in_progress"]);
  assert.equal(prev[0]!.state, "pending", "the old list is not changed");
  assert.deepEqual(list(applyTodo(prev, { set: { id: "2", state: "completed" } })).map((i) => i.state), ["pending", "done"]);
  assert.match((applyTodo(prev, { set: [{ id: "9", state: "done" }] }) as { error: string }).error, /no step "9"\. Steps: 1, 2/);
  assert.match((applyTodo(prev, { set: [{ id: "1", state: "later" }] }) as { error: string }).error, /needs a state/);
  assert.match((applyTodo(prev, {}) as { error: string }).error, /needs "items"/);
});

test("items: [] clears the list", () => {
  assert.deepEqual(list(applyTodo([{ id: "1", title: "a", state: "pending" }], { items: [] })), []);
  assert.equal(todoReply([]), "The list is cleared.");
});

test("todoProgress counts, finds the step in progress and knows when all are done", () => {
  const items: TodoItem[] = [{ id: "1", title: "a", state: "done" }, { id: "2", title: "b", state: "in_progress" }, { id: "3", title: "c", state: "pending" }];
  assert.deepEqual(todoProgress(items), { done: 1, total: 3, current: items[1], finished: false });
  assert.equal(todoProgress(items.map((i) => ({ ...i, state: "done" as const }))).finished, true);
  assert.equal(todoProgress([]).finished, false);
});

test("latestTodo takes the newest todo event; todoReply tells the model what is next", () => {
  const a: TodoItem[] = [{ id: "1", title: "a", state: "pending" }];
  const b: TodoItem[] = [{ id: "1", title: "a", state: "in_progress" }, { id: "2", title: "b", state: "pending" }];
  assert.equal(latestTodo([{ type: "user" }]), undefined);
  assert.deepEqual(latestTodo([{ type: "todo", items: a }, { type: "assistant" }, { type: "todo", items: b }, { type: "user" }]), b);
  assert.match(todoReply(b), /^0\/2 done\.\n\[>\] 1\. a\n\[ \] 2\. b\nNow: 1\./);
  assert.match(todoReply([{ id: "1", title: "a", state: "done" }]), /All steps are done/);
  assert.match(todoReply(a), /Mark the next step in_progress/);
});

test("todoOpenLine: short line while steps are open, none when all done, cut at 120", async () => {
  const { todoOpenLine, todoOpenNudge } = await import("./todo-list.js");
  const items = [{ id: "1", title: "A", state: "done" as const }, { id: "2", title: "B", state: "pending" as const }, { id: "3", title: "C", state: "in_progress" as const }];
  assert.equal(todoOpenLine(items), "Open steps: 2/3 — B; C");
  assert.equal(todoOpenLine([items[0]!]), undefined);
  assert.equal(todoOpenLine(undefined), undefined);
  assert.equal(todoOpenNudge([items[0]!]), undefined);
  const long = [{ id: "1", title: "x".repeat(120), state: "pending" as const }, { id: "2", title: "y".repeat(120), state: "pending" as const }];
  assert.ok(todoOpenLine(long)!.length <= 120);
});

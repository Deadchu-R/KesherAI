import { test } from "node:test";
import assert from "node:assert/strict";
import { todoCount, todoView } from "./todo-view";

const items = [
  { id: "1", title: "Read the code", state: "done" },
  { id: "2", title: "Write tests", state: "in_progress", activeForm: "Writing tests" },
  { id: "3", title: "Check the work", state: "pending" },
];

test("todoView: marks per state, the active form while a step runs, the count", () => {
  const v = todoView([{ type: "user" }, { type: "todo", items }])!;
  assert.deepEqual(v.lines.map((l) => `${l.mark} ${l.text}`), ["✅ Read the code", "🔄 Writing tests", "⬜ Check the work"]);
  assert.deepEqual([v.done, v.total, v.finished, v.current], [1, 3, false, true]);
  assert.deepEqual(todoCount(v), { done: 1, total: 3 });
});

test("todoView: all done folds (no count in the status line); a list from an older request is not current", () => {
  const done = items.map((i) => ({ ...i, state: "done" }));
  const v = todoView([{ type: "user" }, { type: "todo", items: done }])!;
  assert.equal(v.finished, true);
  assert.equal(todoCount(v), undefined);
  const old = todoView([{ type: "user" }, { type: "todo", items }, { type: "assistant" }, { type: "user" }])!;
  assert.equal(old.current, false);
  assert.equal(todoCount(old), undefined);
  assert.equal(todoView([{ type: "user" }, { type: "todo", items }, { type: "user", steered: true }])!.current, true, "a steer is the same turn");
});

test("todoView: no list, or a cleared one, shows nothing", () => {
  assert.equal(todoView([{ type: "user" }]), undefined);
  assert.equal(todoView([{ type: "todo", items }, { type: "todo", items: [] }]), undefined);
});

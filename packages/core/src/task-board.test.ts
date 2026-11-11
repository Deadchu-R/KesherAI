import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskBoard, boardText } from "./task-board.js";

test("two agents share tasks: claim once, done with a result, notes, revisions", async () => {
  const board = new TaskBoard(join(await mkdtemp(join(tmpdir(), "board-")), "self-work", "board.json"));
  let b = await board.change("claude", [{ op: "add", title: "Refactor the composer", priority: 1 }, { op: "add", title: "Fix lint warnings" }]);
  assert.equal(b.rev, 1);
  assert.deepEqual(b.tasks.map((t) => t.id), ["t1", "t2"]);
  b = await board.change("kesher", [{ op: "claim", id: "t2" }]);
  await assert.rejects(board.change("claude", [{ op: "claim", id: "t2" }]), /already taken by kesher/);
  await assert.rejects(board.change("claude", [{ op: "note", text: "hi" }], 1), /changed/, "a stale revision changes nothing");
  b = await board.change("kesher", [{ op: "done", id: "t2", result: "commit abc123, pnpm test passed" }, { op: "note", text: "t2 done, taking nothing else", task: "t2" }], b.rev);
  assert.equal(b.tasks[1]!.status, "done");
  assert.equal(b.notes[0]!.from, "kesher");
  await assert.rejects(board.change("claude", [{ op: "done", id: "t2", result: "x" }]), /belongs to kesher/);
  const text = boardText(await board.read());
  assert.match(text, /t1 \[open\] p1 {big} Refactor the composer/);
  assert.match(text, /Done: 1/);
  assert.match(text, /kesher \(t2\): t2 done/);
});

test("writes in parallel never lose a change", async () => {
  const board = new TaskBoard(join(await mkdtemp(join(tmpdir(), "board-")), "board.json"));
  await Promise.all(Array.from({ length: 20 }, (_, i) => board.change(i % 2 ? "claude" : "kesher", [{ op: "add", title: `task ${i}` }])));
  const b = await board.read();
  assert.equal(b.tasks.length, 20);
  assert.equal(b.rev, 20);
  assert.equal(new Set(b.tasks.map((t) => t.id)).size, 20);
});

test("one list with sizes: self-work takes small ones and tasks handed to it, Claude big ones; Fable stays apart", async () => {
  const board = new TaskBoard(join(await mkdtemp(join(tmpdir(), "board-")), "board.json"));
  let b = await board.change("roee", [
    { op: "add", title: "Refactor the composer" },
    { op: "add", title: "[CoolDown] Small test" },
    { op: "add", title: "Architecture review", category: "fable" },
    { op: "add", title: "Add a test", size: "small" },
  ]);
  // CoolDown joins Normal as a small task (old agents may still say "cooldown").
  assert.deepEqual(b.tasks.map((t) => [t.category, t.size]), [["normal", "big"], ["normal", "small"], ["fable", "big"], ["normal", "small"]]);
  b = await board.change("roee", [{ op: "edit", id: "t1", category: "cooldown" }]);
  assert.deepEqual([b.tasks[0]!.category, b.tasks[0]!.size], ["normal", "small"]);
  b = await board.change("roee", [{ op: "edit", id: "t1", size: "big", forKesher: true }]);
  assert.deepEqual([b.tasks[0]!.size, b.tasks[0]!.forKesher], ["big", true]);
  await assert.rejects(board.change("roee", [{ op: "edit", id: "t1", category: "other" as never }]), /normal, cooldown or fable/);
  await assert.rejects(board.change("roee", [{ op: "edit", id: "t1", size: "huge" as never }]), /small or big/);
  const text = boardText(await board.read());
  assert.match(text, /p5 \{big\} \{for self-work\} Refactor the composer/);
  assert.match(text, /p5 \{small\} \[CoolDown\] Small test/);
  assert.match(text, /p5 \{fable\} Architecture review/);
  b = await board.change("roee", [{ op: "edit", id: "t1", forKesher: false }]);
  assert.equal(b.tasks[0]!.forKesher, undefined);
});

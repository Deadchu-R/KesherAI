import { test } from "node:test";
import assert from "node:assert/strict";
import { dayBreaks, dayLabel, splitArchived } from "./chat-archive";

test("splitArchived keeps the list's order and puts archived chats newest first", () => {
  const r = splitArchived([
    { id: "a", updatedAt: "2026-11-01" },
    { id: "b", updatedAt: "2026-11-02", archived: true },
    { id: "c", updatedAt: "2026-11-05", archived: true },
    { id: "d", updatedAt: "2026-11-03" },
  ]);
  assert.deepEqual(r.active.map((c) => c.id), ["a", "d"]);
  assert.deepEqual(r.archived.map((c) => c.id), ["c", "b"]);
});

test("dayBreaks marks the first message of each new day, not tool steps or the first day", () => {
  const at = (d: number, h: number) => new Date(2026, 10, d, h).toISOString();
  const ev = [
    { type: "user", seq: 1, at: at(19, 9) },
    { type: "assistant", seq: 2, at: at(19, 9) },
    { type: "tool_call", seq: 3, at: at(20, 8) },
    { type: "user", seq: 4, at: at(20, 10) },
    { type: "assistant", seq: 5, at: at(20, 10) },
    { type: "user", seq: 6, at: at(21, 7) },
  ];
  assert.deepEqual([...dayBreaks(ev)], [[4, "2026-11-20"], [6, "2026-11-21"]]);
  assert.equal(dayBreaks(ev.slice(0, 2)).size, 0);
});

test("dayLabel: today, yesterday, then the date", () => {
  const now = new Date(2026, 10, 21, 12);
  assert.equal(dayLabel("2026-11-21", now, false), "Today");
  assert.equal(dayLabel("2026-11-20", now, true), "אתמול");
  assert.match(dayLabel("2026-11-02", now, false), /2 November/);
  assert.match(dayLabel("2025-11-02", now, false), /2025/);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { advance, answer, createRoom, getRoom, join, playerView } from "./live-quiz.js";

const qs = [
  { q: "2+2?", options: ["3", "4"], answer: 1, explain: "" },
  { q: "open", options: [], answer: -1, explain: "" },
  { q: "1+1?", options: ["2", "5"], answer: 0, explain: "two" },
];

test("a live quiz room: join, answer against the clock, scoreboard", () => {
  const r = createRoom("Physio", qs, 20, 1000);
  assert.equal(r.questions.length, 2);
  assert.equal(getRoom(r.token, 1000), r);
  const a = join(r, " Dana<b> ");
  const b = join(r, "Noa");
  assert.equal(r.players.get(a)!.name, "Danab");
  assert.equal(answer(r, a, 0, 1, 1000), false); // still the lobby
  advance(r, 2000);
  assert.ok(!("answer" in playerView(r, a, 2000)));
  assert.equal(answer(r, a, 0, 1, 2000), true);
  assert.equal(answer(r, a, 0, 0, 2100), false); // once
  assert.equal(answer(r, b, 0, 1, 12_000), true);
  assert.equal(r.players.get(a)!.score, 1000);
  assert.equal(r.players.get(b)!.score, 750);
  advance(r);
  const v = playerView(r, b);
  assert.equal(v.answer, 1);
  assert.equal(v.board![0]!.name, "Danab");
  advance(r, 30_000);
  assert.equal(answer(r, b, 1, 0, 30_000 + 25_000), false); // too late
  advance(r);
  advance(r);
  assert.equal(r.stage, "end");
  assert.equal(getRoom(r.token, 1000 + 4 * 3600_000), undefined);
  assert.equal(getRoom("../x"), undefined);
});

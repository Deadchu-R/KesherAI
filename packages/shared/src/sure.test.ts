import { test } from "node:test";
import assert from "node:assert/strict";
import { recentMistakes, type StudyCourseData } from "./study.js";

test("My mistakes: a confident mistake comes first", () => {
  const card = (id: string) => ({ id, front: id, back: "", format: "text" as const, createdAt: 0, due: "", fsrs: {} });
  const now = Date.now();
  const d: StudyCourseData = {
    course: { id: "c", name: "c", createdAt: 0 },
    lectures: [],
    cards: [card("unsure"), card("sure")],
    reviews: [
      { cardId: "sure", t: now - 5000, rating: 1, format: "text", elapsedDays: 0, sure: true },
      { cardId: "unsure", t: now - 1000, rating: 1, format: "text", elapsedDays: 0, sure: false },
    ],
    quizzes: [],
  };
  assert.deepEqual(recentMistakes(d, now).cards.map((c) => c.id), ["sure", "unsure"]);
});

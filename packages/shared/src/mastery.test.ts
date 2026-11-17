import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { topicMastery, type StudyCard, type StudyQuiz, type StudyReview } from "./study.js";

const D = 86_400_000;
const now = 100 * D;
const card = (id: string, lectureId: string) => ({ id, lectureId }) as unknown as StudyCard;
const r = (cardId: string, rating: 1 | 2 | 3 | 4, t: number): StudyReview => ({ cardId, rating, t, format: "text" }) as StudyReview;

describe("topicMastery", () => {
  it("scores each lecture from reviews and quizzes, weakest first, and leaves out thin ones", () => {
    const cards = [card("a", "L1"), card("b", "L2"), card("c", "L3")];
    const reviews = [r("a", 4, now - D), r("a", 3, now - D), r("a", 4, now - D), r("b", 1, now - D), r("b", 2, now - D), r("c", 4, now)];
    const quizzes = [{ id: "q", t: now - D, questions: [{ q: "", options: ["x", "y"], answer: 0, explain: "", lectureId: "L2" }], answers: [1] }] as StudyQuiz[];
    const m = topicMastery(cards, reviews, quizzes, now);
    assert.deepEqual(m.map((x) => x.lectureId), ["L2", "L1"]);
    assert.ok(m[0]!.mastery < 30);
    assert.equal(m[1]!.mastery, 100);
  });
  it("reports a drop against a week ago", () => {
    const cards = [card("a", "L1")];
    const reviews = [...[1, 2, 3, 4].map(() => r("a", 4, now - 10 * D)), ...[1, 2, 3, 4].map(() => r("a", 1, now - D))];
    const [m] = topicMastery(cards, reviews, [], now);
    assert.ok(m!.change < -30);
  });
});

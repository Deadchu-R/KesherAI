import { describe, expect, it } from "vitest";
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
    expect(m.map((x) => x.lectureId)).toEqual(["L2", "L1"]);
    expect(m[0]!.mastery).toBeLessThan(30);
    expect(m[1]!.mastery).toBe(100);
  });
  it("reports a drop against a week ago", () => {
    const cards = [card("a", "L1")];
    const reviews = [...[1, 2, 3, 4].map(() => r("a", 4, now - 10 * D)), ...[1, 2, 3, 4].map(() => r("a", 1, now - D))];
    const [m] = topicMastery(cards, reviews, [], now);
    expect(m!.change).toBeLessThan(-30);
  });
});

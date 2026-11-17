import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { goalRemindNow, goalToday, recentMistakes, studyBadges, weekRecap, type StudyCourseData, type StudyGoal } from "./study.js";

const at = (day: number, hour = 12) => new Date(2026, 10, day, hour).getTime();
const course = (focus: Array<[number, number]>, reviews: number[]) => ({ focus: focus.map(([t, minutes]) => ({ t, minutes })), reviews: reviews.map((t) => ({ t, cardId: "c", rating: 3 })) }) as unknown as StudyCourseData;

describe("daily goal", () => {
  const goal: StudyGoal = { on: true, targets: { minutes: 20, videos: 1 } };
  it("counts today and the days in a row the whole goal was reached", () => {
    const c = course([[at(14), 25], [at(15), 30], [at(16), 10], [at(17), 20]], []);
    const act = [14, 15, 16, 17].map((d) => ({ t: at(d, 9), kind: "videos" as const }));
    const today = goalToday([c], act, goal, at(17, 18));
    assert.equal(today.done, true);
    assert.equal(today.counts.minutes, 20);
    assert.equal(today.streak, 1);
    // Today not reached yet: the streak counts from yesterday.
    const t2 = goalToday([course([[at(15), 30], [at(16), 30]], [])], [15, 16].map((d) => ({ t: at(d), kind: "videos" as const })), goal, at(17, 8));
    assert.equal(t2.done, false);
    assert.equal(t2.streak, 2);
  });
  it("a tired day asks half, and keeps the streak", () => {
    const c = course([[at(16), 20], [at(17), 10]], []);
    const act = [16, 17].map((d) => ({ t: at(d, 9), kind: "videos" as const }));
    const t = goalToday([c], act, goal, at(17, 18), { "2026-11-17": "low" });
    assert.equal(t.targets.minutes, 10);
    assert.equal(t.done, true);
    assert.equal(t.streak, 2);
    assert.equal(goalToday([c], act, goal, at(17, 18)).done, false);
  });
  it("reminds once, after its time, only when not reached and the goal is on", () => {
    const g: StudyGoal = { ...goal, remind: "20:30" };
    assert.equal(goalRemindNow(g, false, undefined, new Date(2026, 10, 17, 20, 29)), false);
    assert.equal(goalRemindNow(g, false, undefined, new Date(2026, 10, 17, 20, 31)), true);
    assert.equal(goalRemindNow(g, true, undefined, new Date(2026, 10, 17, 21)), false);
    assert.equal(goalRemindNow(g, false, "2026-11-17", new Date(2026, 10, 17, 21)), false);
    assert.equal(goalRemindNow({ ...g, on: false }, false, undefined, new Date(2026, 10, 17, 21)), false);
    assert.equal(goalToday([], [], { on: true, targets: {} }).done, false);
  });
});

describe("my mistakes", () => {
  it("forgotten cards until remembered twice, and wrong multiple-choice answers, newest first", () => {
    const now = at(17, 18);
    const d = {
      cards: [{ id: "a", front: "A" }, { id: "b", front: "B" }, { id: "c", front: "C" }],
      reviews: [
        { cardId: "a", t: at(15), rating: 1 },
        { cardId: "b", t: at(14), rating: 1 }, { cardId: "b", t: at(15), rating: 3 }, { cardId: "b", t: at(16), rating: 4 },
        { cardId: "c", t: at(16), rating: 1 }, { cardId: "c", t: at(16, 13), rating: 3 },
      ],
      quizzes: [
        { id: "z", t: at(16), questions: [{ q: "Q1", options: ["x", "y"], answer: 0, explain: "" }, { q: "Q2", options: ["x", "y"], answer: 1, explain: "" }], answers: [1, 1] },
        { id: "o", t: at(16), kind: "open", questions: [{ q: "O", options: [], answer: -1, explain: "" }], answers: [-1] },
      ],
    } as unknown as StudyCourseData;
    const m = recentMistakes(d, now);
    assert.deepEqual(m.cards.map((c) => c.id), ["c", "a"]);
    assert.deepEqual(m.questions.map((q) => q.q), ["Q1"]);
  });
});

describe("week recap", () => {
  it("adds up the last 7 days and counts the days studied", () => {
    const now = at(17, 18);
    const c = { ...course([[at(17), 20], [at(15), 10], [at(5), 99]], [at(16), at(16)]), course: { name: "x" }, cards: [], lectures: [], quizzes: [] } as unknown as StudyCourseData;
    const w = weekRecap([c], [{ t: at(14), kind: "lectures" }], now);
    assert.equal(w.counts.minutes, 30);
    assert.equal(w.counts.cards, 2);
    assert.equal(w.counts.lectures, 1);
    assert.equal(w.days, 4);
  });
});

describe("badges", () => {
  it("come from her own data", () => {
    const d = { course: { name: "x" }, lectures: [{ id: "l", summary: "s" }], cards: [], reviews: Array.from({ length: 100 }, (_, i) => ({ cardId: "c", t: i, rating: 3 })), quizzes: [], focus: [] } as unknown as StudyCourseData;
    const ids = studyBadges([d], [], 8).map((b) => b.id);
    assert.deepEqual(ids, ["first-lecture", "first-summary", "cards-100", "streak-7"]);
  });
});

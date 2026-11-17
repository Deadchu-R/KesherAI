import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { goalRemindNow, goalToday, type StudyCourseData, type StudyGoal } from "./study.js";

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

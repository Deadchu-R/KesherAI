import { test } from "node:test";
import assert from "node:assert/strict";
import { mockHistory, mockMinutes, mockResult, mockTime, type StudyQuiz } from "./study.js";

const q = (answer: number, lectureId: string) => ({ q: "?", options: ["a", "b"], answer, explain: "", lectureId });

test("mock exam: time, extra time and the grade from both parts", () => {
  assert.equal(mockMinutes(20, 0), 30);
  assert.equal(mockMinutes(20, 2), 50);
  assert.equal(mockTime({ minutes: 30, extra: true }), 38);
  assert.equal(mockTime({ minutes: 30 }), 30);
  const choice: StudyQuiz = { id: "c", t: 1, questions: [q(0, "L1"), q(1, "L1"), q(0, "L2")], answers: [0, 0, 0], score: 2, mock: { group: "g1", minutes: 30 } };
  const open: StudyQuiz = { id: "o", t: 2, kind: "open", questions: [{ q: "?", options: [], answer: -1, explain: "", lectureId: "L1" }], marks: [0.5], score: 0.5, mock: { group: "g1", minutes: 30 } };
  assert.equal(mockResult([{ ...choice, score: undefined }]), undefined);
  const r = mockResult([choice, open])!;
  // (2 + 0.5 × 3) of (3 + 3) = 58%
  assert.equal(r.grade, 58);
  assert.deepEqual([r.right, r.choice, r.open, r.openMax], [2, 3, 0.5, 1]);
  assert.equal(r.byLecture[0]!.lectureId, "L1");
  assert.deepEqual(mockHistory([choice, open, { ...choice, id: "x", mock: undefined }]), [{ group: "g1", t: 1, grade: 58 }]);
});

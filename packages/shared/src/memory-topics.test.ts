import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeTopics, monthKey, monthlyRecap, moveFact, searchTopics, type FactTopic } from "./memory-topics.js";

const NOW = "2026-11-21T10:00:00.000Z";
const fact = (text: string, at = "2026-11-01T00:00:00.000Z") => ({ text, at, source: "you" as const });
const make = (): FactTopic[] => [
  { id: "w", title: "Work", facts: [fact("Unreal developer"), fact("Likes UI work", "2026-10-01T00:00:00.000Z")], updatedAt: NOW },
  { id: "j", title: "Job", facts: [fact("unreal developer", "2026-11-10T00:00:00.000Z"), fact("Looking for Unity roles")], updatedAt: NOW },
  { id: "p", title: "Notes", project: "kesher", facts: [fact("Uses pnpm")], updatedAt: NOW },
];

test("mergeTopics joins facts without repeats, keeps the newer copy, removes the source", () => {
  const t = mergeTopics(make(), "j", "w", NOW);
  assert.deepEqual(t.map((x) => x.id), ["w", "p"]);
  const w = t.find((x) => x.id === "w")!;
  assert.deepEqual(w.facts.map((f) => f.text), ["Likes UI work", "Looking for Unity roles", "unreal developer"]);
  assert.equal(w.updatedAt, NOW);
});

test("mergeTopics refuses another scope, itself, or a missing topic", () => {
  assert.throws(() => mergeTopics(make(), "p", "w"), /project/);
  assert.throws(() => mergeTopics(make(), "w", "w"), /another/);
  assert.throws(() => mergeTopics(make(), "x", "w"), /gone/);
});

test("moveFact moves to an existing topic, a new one by title, and drops an emptied topic", () => {
  let t = moveFact(make(), "w", 1, { toId: "j" }, () => "new", NOW);
  assert.deepEqual(t.find((x) => x.id === "w")!.facts.map((f) => f.text), ["Unreal developer"]);
  assert.equal(t.find((x) => x.id === "j")!.facts.length, 3);
  t = moveFact(t, "w", 0, { title: " Skills " }, () => "s1", NOW);
  assert.equal(t.find((x) => x.id === "w"), undefined);
  const s = t.find((x) => x.id === "s1")!;
  assert.equal(s.title, "Skills");
  assert.equal(s.project, undefined);
  // A new title inside a project stays in the project; an existing title (any case) is reused.
  t = moveFact(t, "p", 0, { title: "Tools" }, () => "t1", NOW);
  assert.equal(t.find((x) => x.id === "t1")!.project, "kesher");
  t = moveFact(t, "j", 0, { title: "skills" }, () => "never", NOW);
  assert.equal(t.find((x) => x.id === "never"), undefined);
});

test("moveFact refuses another scope and missing facts", () => {
  assert.throws(() => moveFact(make(), "p", 0, { toId: "w" }, () => "x"), /project/);
  assert.throws(() => moveFact(make(), "w", 9, { toId: "j" }, () => "x"), /gone/);
  assert.throws(() => moveFact(make(), "w", 0, { title: "  " }, () => "x"), /Name/);
});

test("searchTopics keeps the facts' own indices; a title match shows all", () => {
  const r = searchTopics(make(), "unity");
  assert.deepEqual(r.map((x) => [x.topic.id, x.indices]), [["j", [1]]]);
  assert.deepEqual(searchTopics(make(), "WORK").map((x) => [x.topic.id, x.indices]), [["w", [0, 1]]]);
  assert.equal(searchTopics(make(), "").length, 3);
});

test("monthlyRecap lists the last 30 days' facts, newest first, with where they live", () => {
  const r = monthlyRecap(make(), new Date(NOW));
  assert.deepEqual(r.map((x) => x.text), ["unreal developer", "Unreal developer", "Looking for Unity roles", "Uses pnpm"]);
  assert.deepEqual([r[0]!.topicId, r[0]!.index], ["j", 0]);
  assert.equal(r[3]!.project, "kesher");
  assert.equal(monthlyRecap(make(), new Date(NOW), 30, 2).length, 2);
  assert.equal(monthKey(new Date(2026, 0, 5)), "2026-01");
});

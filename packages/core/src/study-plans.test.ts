import { test } from "node:test";
import assert from "node:assert/strict";
import { checkPlan } from "./study-plans.js";

const at = (d: string) => new Date(`${d}T09:00`).getTime();

test("the model's steps stay between today and the due day, and a full day moves earlier", () => {
  const steps = checkPlan({ steps: [{ title: "a", minutes: 60, date: "2026-11-20" }, { title: "b", minutes: 999, date: "2026-12-30" }, { title: "", minutes: 5 }] }, at("2026-11-17"), at("2026-11-23"), { "2026-11-20": 150 });
  assert.deepEqual(steps.map((s) => [s.title, s.date, s.minutes]), [["a", "2026-11-19", 60], ["b", "2026-11-23", 240]]);
});

test("no usable steps: an even plan of three", () => {
  const steps = checkPlan(undefined, at("2026-11-17"), at("2026-11-21"));
  assert.deepEqual(steps.map((s) => s.date), ["2026-11-17", "2026-11-19", "2026-11-21"]);
});

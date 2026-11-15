import { test } from "node:test";
import assert from "node:assert/strict";
import { parseChart, shortNumber, ticks } from "./chart.js";

test("a chart block is read, cleaned and bounded", () => {
  const c = parseChart('{"type":"line","title":"Sales","labels":["Jan","Feb","Mar"],"series":[{"name":"2026","values":[3,"x",5]}],"unit":"%"}');
  assert.deepEqual(c, { type: "line", title: "Sales", unit: "%", labels: ["Jan", "Feb", "Mar"], series: [{ name: "2026", values: [3, 0, 5] }] });
  // Plain "values" is one series; no type is a bar chart; a pie keeps one series.
  assert.equal(parseChart('{"labels":["a"],"values":[1]}')?.type, "bar");
  assert.equal(parseChart('{"type":"pie","labels":["a","b"],"series":[{"values":[1,2]},{"values":[3,4]}]}')?.series.length, 1);
  // Not a chart: shown as code.
  for (const bad of ["{", "[]", '{"labels":[]}', '{"type":"radar","labels":["a"],"values":[1]}', '{"labels":["a"]}']) assert.equal(parseChart(bad), undefined, bad);
});

test("axis steps are round and cover the values", () => {
  assert.deepEqual(ticks(0, 10), [0, 2.5, 5, 7.5, 10]);
  const t = ticks(-3, 47);
  assert.ok(t[0]! <= -3 && t.at(-1)! >= 47);
  assert.equal(shortNumber(12_500), "12.5K");
  assert.equal(shortNumber(3.14159), "3.14");
});

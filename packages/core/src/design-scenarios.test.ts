import { test } from "node:test";
import assert from "node:assert/strict";
import { parseScenarioFile, parseScenarios, resolveTimes } from "./design-scenarios.js";

const file = (o: object) => JSON.stringify({ group: "משחקים", now: "2026-11-20T10:00:00Z", boards: [{ id: "Games", title: "משחקים", route: "#/games" }], ...o });

test("a board becomes a computer and a phone job with the right names and sizes", () => {
  const jobs = parseScenarioFile(file({}), "games.json");
  assert.deepEqual(jobs.map((j) => [j.name, j.viewport, j.width, j.height]), [["Games.dc.html", "desktop", 1280, 800], ["GamesPhone.dc.html", "phone", 390, 844]]);
  assert.equal(jobs[1]!.title, "משחקים · בטלפון");
  assert.equal(jobs[0]!.locale, "he");
});

test("heights per size, phone steps and board mocks before the file's", () => {
  const jobs = parseScenarioFile(file({
    mocks: [{ url: "**/api/a", json: 1 }],
    boards: [{ id: "G", title: "t", route: "#/g", height: { phone: 1200 }, steps: [{ wait: ".x" }], phoneSteps: [{ click: ".y" }], mocks: [{ url: "**/api/b", json: 2 }] }],
  }), "f.json");
  assert.equal(jobs[0]!.height, 800);
  assert.equal(jobs[1]!.height, 1200);
  assert.deepEqual(jobs[0]!.steps, [{ wait: ".x" }]);
  assert.deepEqual(jobs[1]!.steps, [{ click: ".y" }]);
  assert.deepEqual(jobs[0]!.mocks.map((m) => m.url), ["**/api/b", "**/api/a"]);
});

test("relative times become fixed ones from the file's clock", () => {
  const now = Date.parse("2026-11-20T10:00:00Z");
  assert.deepEqual(resolveTimes({ a: [{ at: { $ago: "40m" } }], b: { $agoMs: "1h" }, c: "x" }, now), { a: [{ at: "2026-11-20T09:20:00.000Z" }], b: now - 3_600_000, c: "x" });
  const [job] = parseScenarioFile(file({ mocks: [{ url: "**/api/t", json: { t: { $ago: "2d" } } }] }), "f.json");
  assert.deepEqual(job!.mocks[0]!.json, { t: "2026-11-18T10:00:00.000Z" });
  assert.throws(() => resolveTimes({ $ago: "soon" }, now), /40m/);
});

test("bad files name the file and field; ids cannot be paths", () => {
  assert.throws(() => parseScenarioFile("{", "a.json"), /a\.json: not valid JSON/);
  assert.throws(() => parseScenarioFile(file({ boards: [{ id: "../x", title: "t", route: "#/g" }] }), "b.json"), /b\.json: boards\.0\.id/);
  assert.throws(() => parseScenarioFile(file({ boards: [{ id: "X", title: "t", route: "http://evil" }] }), "c.json"), /route/);
  assert.throws(() => parseScenarioFile(file({ boards: [{ id: "X", title: "t", route: "#/g", steps: [{ eval: "1" }] }] }), "d.json"), /d\.json: boards\.0\.steps/);
});

test("several files: a broken one is reported, the rest still render; names must be unique", () => {
  const r = parseScenarios([{ name: "a.json", text: file({}) }, { name: "b.json", text: "nope" }, { name: "c.json", text: file({}) }]);
  assert.equal(r.jobs.length, 2);
  assert.equal(r.errors.length, 2);
  assert.match(r.errors[1]!, /c\.json: board Games\.dc\.html is already in a\.json/);
});

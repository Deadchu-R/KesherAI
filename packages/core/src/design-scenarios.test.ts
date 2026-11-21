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
  assert.deepEqual(resolveTimes({ a: { $in: "1d" }, b: { $inMs: "5m" } }, now), { a: "2026-11-21T10:00:00.000Z", b: now + 300_000 });
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

test("every scenario file in the repo parses, with no board name used twice", async () => {
  const { readdir, readFile } = await import("node:fs/promises");
  const dir = new URL("../../../tools/design/scenarios/", import.meta.url);
  const names = (await readdir(dir)).filter((f) => f.endsWith(".json")).sort();
  const r = parseScenarios(await Promise.all(names.map(async (name) => ({ name, text: await readFile(new URL(name, dir), "utf8") }))));
  assert.deepEqual(r.errors, []);
  assert.ok(r.jobs.length >= 28);
});

test("a hub board takes a tab or a path as its route and its own seed; an app route on a hub board (and the reverse) is refused", () => {
  const hub = parseScenarioFile(JSON.stringify({ group: "האב", target: "hub", boards: [{ id: "S", title: "t", route: "#settings", hub: { push: true, device: { name: "p" } } }, { id: "C", title: "t", route: "/connect?client_id=x" }] }), "hub.json");
  assert.deepEqual(hub.map((j) => [j.name, j.target]), [["S.dc.html", "hub"], ["SPhone.dc.html", "hub"], ["C.dc.html", "hub"], ["CPhone.dc.html", "hub"]]);
  assert.equal(hub[0]!.hub?.push, true);
  assert.equal(hub[2]!.hub?.signedIn, true);
  assert.throws(() => parseScenarioFile(JSON.stringify({ group: "g", target: "hub", boards: [{ id: "S", title: "t", route: "#/games" }] }), "f.json"), /hub board's route/);
  assert.throws(() => parseScenarioFile(JSON.stringify({ group: "g", boards: [{ id: "S", title: "t", route: "#settings" }] }), "f.json"), /route/);
  assert.equal(parseScenarioFile(JSON.stringify({ group: "g", boards: [{ id: "S", title: "t", route: "#/games" }] }), "f.json")[0]!.target, "app");
});

test("shot is one selector for both sizes, or one per size", () => {
  const jobs = (shot: unknown) => parseScenarioFile(file({ boards: [{ id: "G", title: "t", route: "#/g", shot }] }), "f.json");
  assert.deepEqual(jobs(".a").map((j) => j.shot), [".a", ".a"]);
  assert.deepEqual(jobs({ desktop: ".d" }).map((j) => j.shot), [".d", undefined]);
  assert.deepEqual(jobs(undefined).map((j) => j.shot), [undefined, undefined]);
});

test("a mock may answer with a binary body (base64), and only base64 characters", () => {
  const ok = parseScenarioFile(file({ mocks: [{ url: "**/v", bodyBase64: "GkXfow==", contentType: "video/webm" }] }), "v.json");
  assert.equal(ok[0]!.mocks[0]!.bodyBase64, "GkXfow==");
  assert.throws(() => parseScenarioFile(file({ mocks: [{ url: "**/v", bodyBase64: "not base64!" }] }), "w.json"), /bodyBase64/);
});

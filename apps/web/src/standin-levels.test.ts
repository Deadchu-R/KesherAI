import { test } from "node:test";
import assert from "node:assert/strict";
import { cmpVersion, installOf, orderProjects, pluginAtLeast } from "./standin-levels.js";

test("versions compare by number, not by text", () => {
  assert.ok(cmpVersion("0.1.30", "0.1.23") > 0);
  assert.ok(cmpVersion("0.1.9", "0.1.23") < 0);
  assert.equal(cmpVersion("0.1", "0.1.0"), 0);
  assert.ok(pluginAtLeast("0.1.23", "0.1.23"));
  assert.ok(!pluginAtLeast("0.1.22", "0.1.23"));
  assert.ok(!pluginAtLeast(null, "0.1.23"));
  assert.ok(!pluginAtLeast("?", "0.1.23"), "an unreadable version is not ready");
});

test("cards: levels and a ready plugin first, then ready, then the rest; ties keep their order", () => {
  const p = (name: string, plugin: string | null) => ({ name, path: `C:/${name}`, plugin });
  const list = [p("A", null), p("B", "0.1.30"), p("C", "0.1.10"), p("D", "0.1.30"), p("E", "0.1.25")];
  const counts = new Map([["C:/D", 3], ["C:/C", 5]]);
  assert.deepEqual(orderProjects(list, counts, "0.1.23").map((x) => x.name), ["D", "B", "E", "A", "C"]);
  assert.deepEqual(list.map((x) => x.name), ["A", "B", "C", "D", "E"], "the input is not changed");
});

test("install state from the engines answer: one job, or the batch", () => {
  const path = "C:/Projects/Game";
  assert.equal(installOf({}, path).state, "idle");
  assert.equal(installOf({ job: { state: "building", project: "c:/projects/game/" } }, path).state, "running");
  assert.equal(installOf({ job: { state: "done", project: path } }, path).state, "done");
  assert.deepEqual(installOf({ job: { state: "failed", project: path, message: "no engine" } }, path), { state: "failed", message: "no engine" });
  assert.equal(installOf({ job: { state: "building", project: "C:/Other" } }, path).state, "idle", "another project's job");
  assert.equal(installOf({ batch: { running: true, items: [{ path, state: "queued" }] } }, path).state, "running");
  assert.equal(installOf({ batch: { running: false, items: [{ path, state: "failed", message: "x" }] } }, path).state, "failed");
});

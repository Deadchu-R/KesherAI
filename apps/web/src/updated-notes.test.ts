import { test } from "node:test";
import assert from "node:assert/strict";
import { cmpVersion, phoneAppBehind, versionsSince } from "./updated-notes.js";

const rel = (v: string, ...notes: string[]) => ({ version: v, notes });

test("versions compare by number, not by text", () => {
  assert.ok(cmpVersion("0.6.10", "0.6.9") > 0);
  assert.ok(cmpVersion("v0.6.9", "0.6.9") === 0);
});

test("the notes of every version since the phone last saw one, newest first", () => {
  const list = [rel("0.6.441", "c"), rel("0.6.440", "b1", "b2"), rel("0.6.439", "a"), rel("0.6.438", "old")];
  const r = versionsSince(list, "0.6.438", "0.6.441");
  assert.deepEqual(r.map((x) => x.version), ["0.6.441", "0.6.440", "0.6.439"]);
  assert.deepEqual(r[1]!.notes, ["b1", "b2"]);
});

test("nothing is new when the version is the same or older", () => {
  assert.deepEqual(versionsSince([rel("0.6.5", "x")], "0.6.5", "0.6.5"), []);
  assert.deepEqual(versionsSince([], "0.6.6", "0.6.5"), []);
});

test("a version missing from the list still gets its own line; the list is capped", () => {
  assert.deepEqual(versionsSince([], "0.6.1", "0.6.9"), [{ version: "0.6.9", notes: [] }]);
  const many = Array.from({ length: 9 }, (_, i) => rel(`0.6.${20 - i}`, "1", "2", "3", "4", "5"));
  const r = versionsSince(many, "0.6.1", "0.6.20");
  assert.equal(r.length, 4);
  assert.equal(r[0]!.notes.length, 3);
});

test("a release newer than the computer runs is left out", () => {
  const r = versionsSince([rel("0.6.12", "future"), rel("0.6.11", "now")], "0.6.10", "0.6.11");
  assert.deepEqual(r.map((x) => x.version), ["0.6.11"]);
});

test("the phone app is behind only when both versions are known and a newer one exists", () => {
  assert.ok(phoneAppBehind("0.6.10", "0.6.11"));
  assert.ok(!phoneAppBehind("0.6.11", "0.6.11"));
  assert.ok(!phoneAppBehind(undefined, "0.6.11"));
  assert.ok(!phoneAppBehind("0.6.10", undefined));
});

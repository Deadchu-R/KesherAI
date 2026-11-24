import { test } from "node:test";
import assert from "node:assert/strict";
import { carriedTimes, levelOf, parseLog } from "./log-parse.js";

test("Unreal lines: time (UTC), category, verbosity and message", () => {
  const [a, b, c] = parseLog(
    [
      "[2026.11.24-10.00.01:123][ 42]LogBlueprint: Error: Node not found in BP_Door",
      "[2026.11.24-10.00.02:000][ 43]LogTemp: Warning: Slow frame 48 ms",
      "LogInit: Display: Running engine for game: Shooter",
    ].join("\r\n"),
  );
  assert.equal(a!.t, Date.UTC(2026, 10, 24, 10, 0, 1, 123));
  assert.deepEqual([a!.level, a!.cat, a!.msg], ["error", "LogBlueprint", "Node not found in BP_Door"]);
  assert.deepEqual([b!.level, b!.cat], ["warning", "LogTemp"]);
  assert.deepEqual([c!.level, c!.cat, c!.t], ["info", "LogInit", undefined]);
});

test("ISO time with level words, Python logging, and JSON lines", () => {
  const e = parseLog(
    [
      "2026-11-24T10:00:00.000Z [ERROR] engine stopped",
      "2026-11-24 10:00:01,250 - kesher.inbox - WARNING - quota low",
      '{"at":"2026-11-24T10:00:02.000Z","kind":"server","where":"x","message":"boom","level":"error"}',
      '{"time":1764000000,"level":30,"msg":"ok"}',
    ].join("\n"),
  );
  assert.deepEqual([e[0]!.level, e[0]!.msg], ["error", "engine stopped"]);
  assert.deepEqual([e[1]!.level, e[1]!.cat, e[1]!.msg], ["warning", "kesher.inbox", "quota low"]);
  assert.equal(e[1]!.t, Date.parse("2026-11-24T10:00:01.250"));
  assert.deepEqual([e[2]!.level, e[2]!.cat, e[2]!.msg], ["error", "server", "boom"]);
  assert.deepEqual([e[3]!.level, e[3]!.t], ["info", 1764000000_000]);
});

test("stack traces stay with their line (indented, Python, Unity frames, untimed lines in a timed log)", () => {
  const e = parseLog(
    [
      "2026-11-24T10:00:00Z Error: cannot read x",
      "    at foo (a.js:1:2)",
      "    at bar (b.js:3:4)",
      "2026-11-24T10:00:01Z next",
      "NullReferenceException: Object reference not set",
      "Player.Update () (at Assets/Player.cs:12)",
      "UnityEngine.Debug:Log (object)",
    ].join("\n"),
  );
  assert.equal(e.length, 2);
  assert.deepEqual(e[0]!.extra, ["    at foo (a.js:1:2)", "    at bar (b.js:3:4)"]);
  // In a timed log a line without a time belongs to the line before it.
  assert.equal(e[1]!.extra?.length, 3);

  const unity = parseLog(["NullReferenceException: Object reference not set", "Player.Update () (at Assets/Player.cs:12)", "UnityEngine.Debug:Log (object)", "Loaded scene"].join("\n"));
  assert.equal(unity.length, 2);
  assert.equal(unity[0]!.level, "error");
  assert.equal(unity[0]!.extra?.length, 2);
  assert.equal(unity[1]!.level, "info");
});

test("levels: words, numbers, letters only with a mark; guesses avoid '0 errors'", () => {
  assert.equal(levelOf("Fatal"), "error");
  assert.equal(levelOf(40), "warning");
  assert.equal(levelOf("VeryVerbose"), "debug");
  assert.equal(levelOf("nope"), undefined);
  const e = parseLog(["E: bad", "I think it works", "Build done with 0 errors", "W: careful", "Compile failed"].join("\n"));
  assert.deepEqual(e.map((x) => x.level), ["error", "info", "info", "warning", "error"]);
});

test("a very long trace is cut, with a note of how many lines were left", () => {
  const text = ["2026-11-24T10:00:00Z Error: deep", ...Array.from({ length: 100 }, (_, i) => `    at f${i} (x.js:1:1)`)].join("\n");
  const [e] = parseLog(text);
  assert.equal(e!.extra!.length, 61);
  assert.equal(e!.extra!.at(-1), "… 40 more lines");
});

test("carriedTimes gives untimed entries the time before them", () => {
  const e = parseLog(["plain", "2026-11-24T10:00:00Z a", "E: b"].join("\n"));
  assert.equal(e.length, 3);
  const t = carriedTimes(e);
  assert.equal(t[0], undefined);
  assert.equal(t[2], Date.parse("2026-11-24T10:00:00Z"));
});
